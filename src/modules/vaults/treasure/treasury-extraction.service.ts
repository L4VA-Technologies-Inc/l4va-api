import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey, TransactionUnspentOutput } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../processing-tx/onchain/blockchain.service';
import { getVaultUtxo } from '../processing-tx/onchain/utils/lib';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { AssetStatus } from '@/types/asset.types';
import { TransactionType } from '@/types/transaction.types';

export interface TreasuryExtractionConfig {
  vaultId: string;
  assetIds: string[];
  treasuryAddress?: string; // Optional per-vault treasury
}

export interface ExtractionResult {
  success: boolean;
  transactionId: string;
  extractedAssets: Array<{
    assetId: string;
    policyId: string;
    assetName: string;
    contributionTxHash: string;
  }>;
  treasuryAddress: string;
}

export interface BatchExtractionResult {
  vaultId: string;
  totalAssets: number;
  successfulExtractions: number;
  failedExtractions: number;
  results: ExtractionResult[];
  errors: Array<{
    assetId: string;
    error: string;
  }>;
}

/**
 * Service for extracting assets from vault contributions to treasury wallets
 * Supports both single asset extraction and batch operations
 */
@Injectable()
export class TreasuryExtractionService {
  private readonly logger = new Logger(TreasuryExtractionService.name);
  private readonly adminAddress: string;
  private readonly adminSKey: string;
  private readonly adminHash: string;
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Extract specific assets from a vault to treasury address
   */
  async extractAssetsToTreasury(config: TreasuryExtractionConfig): Promise<ExtractionResult> {
    this.logger.log(`Extracting ${config.assetIds.length} assets from vault ${config.vaultId} to treasury`);

    // 1. Validate vault
    const vault = await this.vaultRepository.findOne({
      where: { id: config.vaultId },
      relations: ['owner'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${config.vaultId} not found`);
    }

    // 2. Get assets to extract
    const assets = await this.assetsRepository.find({
      where:
        config.assetIds.length > 0
          ? {
              id: In(config.assetIds),
              vault: { id: config.vaultId },
              status: AssetStatus.LOCKED,
            }
          : {
              vault: { id: config.vaultId },
              status: AssetStatus.LOCKED,
            },
      relations: ['transaction'],
    });

    if (assets.length === 0) {
      throw new BadRequestException(`No locked assets found for vault ${config.vaultId}`);
    }

    // 3. Group by contribution transaction
    const assetsByContribution = new Map<string, Asset[]>();
    for (const asset of assets) {
      if (!asset.transaction?.tx_hash) continue;
      const txHash = asset.transaction.tx_hash;
      if (!assetsByContribution.has(txHash)) {
        assetsByContribution.set(txHash, []);
      }
      assetsByContribution.get(txHash)!.push(asset);
    }

    // 4. Extract from first contribution (for now)
    const [contributionTxHash, contributionAssets] = Array.from(assetsByContribution.entries())[0];

    // 5. Get contribution UTXO details
    const txUtxos = await this.blockfrost.txsUtxos(contributionTxHash);

    // Find the output with the contribution script address and assets
    const contributionOutput = txUtxos.outputs.find(
      output =>
        output.address === vault.contract_address &&
        output.amount.some(a => contributionAssets.some(asset => a.unit === `${asset.policy_id}${asset.asset_id}`))
    );

    if (!contributionOutput) {
      throw new NotFoundException(`Contribution UTXO not found in tx ${contributionTxHash}`);
    }

    // 6. Extract assets from UTXO (excluding lovelace and receipt token)
    const assetsToExtract = contributionOutput.amount
      .filter((a: any) => {
        if (a.unit === 'lovelace') return false;
        if (a.unit.endsWith('72656365697074')) return false; // "receipt" in hex
        return true;
      })
      .map((a: any) => ({
        policyId: a.unit.slice(0, 56),
        assetName: {
          name: a.unit.slice(56),
          format: 'hex' as const,
        },
        quantity: parseInt(a.quantity),
      }));

    const lovelace = contributionOutput.amount.find((a: any) => a.unit === 'lovelace')?.quantity || '0';

    // 7. Build transaction via Ada Anvil API
    const treasuryAddress = config.treasuryAddress || this.adminAddress;

    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.extract,
      assets: [],
      metadata: {
        extractionType: 'treasury',
        treasuryAddress,
        contributionTxHash,
        assetCount: contributionAssets.length,
      },
    });

    const input = {
      changeAddress: this.adminAddress,
      message: 'Admin extract assets from vault to treasury',
      scriptInteractions: [
        {
          purpose: 'spend',
          hash: vault.script_hash,
          outputRef: {
            txHash: contributionTxHash,
            index: contributionOutput.output_index,
          },
          redeemer: {
            type: 'json',
            value: {
              __variant: 'ExtractAsset',
              __data: {
                vault_token_output_index: null,
              },
            },
          },
        },
      ],
      outputs: [
        {
          address: treasuryAddress,
          lovelace: lovelace,
          assets: assetsToExtract,
        },
      ],
      requiredSigners: [this.adminHash],
      referenceInputs: [
        {
          txHash: vault.last_update_tx_hash,
          index: 0,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      network: this.configService.get<string>('CARDANO_NETWORK'),
    };

    const buildResponse = await this.blockchainService.buildTransaction(input);

    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    const response = await this.blockchainService.submitTransaction({
      transaction: txToSubmitOnChain.to_hex(),
    });

    await this.transactionsService.updateTransactionHash(transaction.id, response.txHash);

    return {
      success: true,
      transactionId: transaction.id,
      extractedAssets: contributionAssets.map(asset => ({
        assetId: asset.id,
        policyId: asset.policy_id,
        assetName: asset.asset_id,
        contributionTxHash,
      })),
      treasuryAddress,
    };
  }

  /**
   * Get the contribution UTXO from vault contract for a specific transaction
   */
  private async getContributionUtxo(
    vault: Vault,
    contributionTxHash: string
  ): Promise<TransactionUnspentOutput | null> {
    try {
      // Get the vault script address
      const vaultScriptAddress = vault.contract_address;

      if (!vaultScriptAddress) {
        throw new BadRequestException('Vault has no contract address');
      }

      // Get all UTXOs at the vault script address
      const utxos = await this.blockfrost.addressesUtxosAsset(
        vaultScriptAddress,
        `${vault.policy_id}${Buffer.from('receipt', 'utf8').toString('hex')}`
      );

      // Find the UTXO that originated from the contribution transaction
      const matchingUtxo = utxos.find(utxo => utxo.tx_hash === contributionTxHash);

      if (!matchingUtxo) {
        return null;
      }

      // Get the full UTXO with CSL conversion
      const txUnspentOutput = await getVaultUtxo(
        matchingUtxo.tx_hash,
        String(matchingUtxo.output_index),
        this.blockfrost
      );

      return txUnspentOutput as any; // Type assertion for CSL object
    } catch (error) {
      this.logger.error(`Error getting contribution UTXO for ${contributionTxHash}:`, error);
      return null;
    }
  }

  /**
   * Build the ExtractAsset transaction payload
   */
  private async buildExtractAssetTransaction(params: {
    vault: Vault;
    contributionUtxo: TransactionUnspentOutput;
    assets: Asset[];
    treasuryAddress: string;
    adminUtxos: string[];
  }): Promise<any> {
    const { vault, contributionUtxo, assets, treasuryAddress, adminUtxos } = params;

    // const datumTag = generate_tag_from_txhash_index(tx_hash, Number(index));

    // Build the transaction input for the blockchain service
    return {
      collateralUtxos: adminUtxos.slice(0, 1), // Use first admin UTXO as collateral
      changeAddress: this.adminAddress,
      vaultUtxos: [contributionUtxo], // The contribution UTXO to spend
      outputs: [
        {
          address: treasuryAddress,
          assets: assets.map(asset => ({
            policyId: asset.policy_id,
            assetName: asset.asset_id,
            quantity: asset.quantity.toString(),
          })),
          datum: {
            type: 'inline',
            // value: PlutusData.new_bytes(Buffer.from(datumTag, 'hex')).to_hex(),
          },
        },
      ],
      redeemer: {
        type: 'ExtractAsset',
        vaultTokenOutputIndex: null, // null means VTs already collected
      },
      requiredSigners: [this.adminHash],
      referenceInputs: [
        {
          txHash: vault.last_update_tx_hash,
          index: 0,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      network: 'preprod',
      signers: [this.adminSKey],
    };
  }
}
