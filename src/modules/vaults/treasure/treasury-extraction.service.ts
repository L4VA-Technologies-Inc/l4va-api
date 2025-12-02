import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, PlutusData, TransactionUnspentOutput } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../processing-tx/onchain/blockchain.service';
import { generate_tag_from_txhash_index, getUtxosExtract, getVaultUtxo } from '../processing-tx/onchain/utils/lib';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AssetStatus } from '@/types/asset.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

export interface TreasuryExtractionConfig {
  vaultId: string;
  assetIds: string[];
  treasuryAddress?: string; // Optional per-vault treasury
}

export interface ExtractionResult {
  success: boolean;
  transactionId: string;
  presignedTxHex: string;
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
  private readonly scPolicyId: string;
  private readonly blockfrost: BlockFrostAPI;
  private readonly blueprintTitle: string;
  private readonly unparametizedScriptHash: string;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly transactionsService: TransactionsService
  ) {
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.unparametizedScriptHash = this.configService.get<string>('CONTRIBUTION_SCRIPT_HASH');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Extract specific assets from a vault to treasury address
   * This builds an ExtractAsset transaction for testing purposes
   */
  async extractAssetsToTreasury(config: TreasuryExtractionConfig): Promise<ExtractionResult> {
    this.logger.log(`Extracting ${config.assetIds.length} assets from vault ${config.vaultId} to treasury`);

    // 1. Validate vault exists and get details
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
              status: AssetStatus.LOCKED, // Only extract locked assets
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

    this.logger.log(`Found ${assets.length} assets to extract`);

    // 3. Determine treasury address (per-vault or default admin)
    const treasuryAddress = config.treasuryAddress || this.adminAddress;

    this.logger.log(`Treasury address: ${treasuryAddress}`);

    // 4. Get admin UTXOs for transaction fees
    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost);

    if (adminUtxos.length === 0) {
      throw new BadRequestException('No admin UTXOs available for fees');
    }

    // 5. Group assets by their contribution transaction
    const assetsByContribution = new Map<string, Asset[]>();

    for (const asset of assets) {
      if (!asset.transaction?.tx_hash) {
        this.logger.warn(`Asset ${asset.id} has no contribution transaction, skipping`);
        continue;
      }

      const txHash = asset.transaction.tx_hash;
      if (!assetsByContribution.has(txHash)) {
        assetsByContribution.set(txHash, []);
      }
      assetsByContribution.get(txHash)!.push(asset);
    }

    this.logger.log(`Assets grouped into ${assetsByContribution.size} contribution transactions`);

    // 6. Build extraction transaction for the first contribution
    // (For testing, we'll extract from one contribution at a time)
    const [contributionTxHash, contributionAssets] = Array.from(assetsByContribution.entries())[0];

    // 7. Get the contribution UTXO from the vault contract
    const contributionUtxo = await this.getContributionUtxo(vault, contributionTxHash);

    if (!contributionUtxo) {
      throw new NotFoundException(`Contribution UTXO not found for transaction ${contributionTxHash}`);
    }

    // 8. Build the ExtractAsset tranactions
    const buildTxInput = await this.buildExtractAssetTransaction({
      vault,
      contributionUtxo,
      assets: contributionAssets,
      treasuryAddress,
      adminUtxos,
    });

    // 9. Call blockchain service to build transaction
    const buildResponse = await this.blockchainService.buildTransaction(buildTxInput);

    // 10. Create transaction record
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.extract,
      assets: [], // Empty assets array, details in metadata
      metadata: {
        extractionType: 'treasury',
        treasuryAddress,
        contributionTxHash,
        assetCount: contributionAssets.length,
        assetIds: contributionAssets.map(a => a.id),
      },
    });

    this.logger.log(`Built extraction transaction ${transaction.id} for ${contributionAssets.length} assets`);

    return {
      success: true,
      transactionId: transaction.id,
      presignedTxHex: buildResponse.complete,
      extractedAssets: contributionAssets.map(asset => ({
        assetId: asset.id,
        policyId: asset.policy_id,
        assetName: asset.asset_id, // asset_id is the hex-encoded asset name
        contributionTxHash,
      })),
      treasuryAddress,
    };
  }

  /**
   * Extract all eligible assets from a vault to treasury (batch operation)
   */
  async extractAllVaultAssetsToTreasury(vaultId: string, treasuryAddress?: string): Promise<BatchExtractionResult> {
    this.logger.log(`Starting batch extraction for vault ${vaultId}`);

    // 1. Get all locked assets in the vault
    const assets = await this.assetsRepository.find({
      where: {
        vault: { id: vaultId },
        status: AssetStatus.LOCKED,
      },
      relations: ['transaction'],
    });

    if (assets.length === 0) {
      return {
        vaultId,
        totalAssets: 0,
        successfulExtractions: 0,
        failedExtractions: 0,
        results: [],
        errors: [],
      };
    }

    this.logger.log(`Found ${assets.length} locked assets to extract`);

    // 2. Group assets by contribution transaction
    const assetsByContribution = new Map<string, Asset[]>();

    for (const asset of assets) {
      if (!asset.transaction?.tx_hash) {
        continue;
      }
      const txHash = asset.transaction.tx_hash;
      if (!assetsByContribution.has(txHash)) {
        assetsByContribution.set(txHash, []);
      }
      assetsByContribution.get(txHash)!.push(asset);
    }

    // 3. Extract from each contribution sequentially
    const results: ExtractionResult[] = [];
    const errors: Array<{ assetId: string; error: string }> = [];

    for (const [contributionTxHash, contributionAssets] of assetsByContribution) {
      try {
        const result = await this.extractAssetsToTreasury({
          vaultId,
          assetIds: contributionAssets.map(a => a.id),
          treasuryAddress,
        });

        results.push(result);

        this.logger.log(`Successfully prepared extraction for contribution ${contributionTxHash}`);

        // Wait a bit between transactions to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        this.logger.error(`Failed to extract assets from contribution ${contributionTxHash}:`, error);

        contributionAssets.forEach(asset => {
          errors.push({
            assetId: asset.id,
            error: error.message || 'Unknown error',
          });
        });
      }
    }

    return {
      vaultId,
      totalAssets: assets.length,
      successfulExtractions: results.reduce((sum, r) => sum + r.extractedAssets.length, 0),
      failedExtractions: errors.length,
      results,
      errors,
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

  /**
   * Mark assets as extracted after successful transaction submission
   */
  async markAssetsAsExtracted(transactionId: string, txHash: string): Promise<void> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId },
      relations: ['assets'],
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }

    // Update transaction with tx hash
    await this.transactionRepository.update(transactionId, {
      tx_hash: txHash,
      status: TransactionStatus.submitted,
    });

    // Mark assets as extracted (using RELEASED status for now)
    if (transaction.assets && transaction.assets.length > 0) {
      await this.assetsRepository.update(
        transaction.assets.map(a => a.id),
        {
          status: AssetStatus.RELEASED, // Assets released from vault
          released_at: new Date(),
        }
      );
    }

    this.logger.log(`Marked ${transaction.assets?.length || 0} assets as extracted for transaction ${txHash}`);
  }
}
