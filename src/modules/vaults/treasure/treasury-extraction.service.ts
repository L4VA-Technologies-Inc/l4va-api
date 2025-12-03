import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TransactionsService } from '../processing-tx/offchain-tx/transactions.service';
import { BlockchainService } from '../processing-tx/onchain/blockchain.service';

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
  extractedAssets: Array<{
    assetId: string;
    policyId: string;
    assetName: string;
    contributionTxHash: string;
  }>;
  treasuryAddress: string;
}

interface UtxoGroup {
  txHash: string;
  outputIndex: number;
  assets: Asset[];
  lovelace: string;
  assetsToExtract: Array<{
    policyId: string;
    assetName: { name: string; format: 'hex' };
    quantity: number;
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
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
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

  async extractAssetsToTreasury(config: TreasuryExtractionConfig): Promise<ExtractionResult> {
    this.logger.log(`Extracting ${config.assetIds.length} assets from vault ${config.vaultId} to treasury`);

    // 1. Validate vault
    const vault = await this.vaultRepository.findOne({
      where: { id: config.vaultId },
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

    // 3. Get all claim transactions for this vault
    const claimTxs = await this.transactionRepository.find({
      where: {
        vault_id: config.vaultId,
        type: TransactionType.claim,
        status: TransactionStatus.confirmed,
      },
      order: {
        created_at: 'DESC',
      },
    });

    this.logger.log(`Found ${claimTxs.length} claim transactions to check`);

    // 4. Check each claim transaction to see which assets are in which UTXO
    const assetsByTxHash = new Map<string, Asset[]>();

    for (const asset of assets) {
      const assetUnit = `${asset.policy_id}${asset.asset_id}`;
      let foundInClaim = false;

      // Check claim transactions (most recent first)
      for (const claimTx of claimTxs) {
        if (!claimTx.tx_hash) continue;

        try {
          const txUtxos = await this.blockfrost.txsUtxos(claimTx.tx_hash);

          // Check if this asset exists in any output of this claim tx
          const hasAssetInOutput = txUtxos.outputs.some(output => {
            const isAtScript = output.address === vault.contract_address;
            const hasThisAsset = output.amount.some((a: any) => a.unit === assetUnit);
            const notConsumed = !output.consumed_by_tx;

            return isAtScript && hasThisAsset && notConsumed;
          });

          if (hasAssetInOutput) {
            if (!assetsByTxHash.has(claimTx.tx_hash)) {
              assetsByTxHash.set(claimTx.tx_hash, []);
            }
            assetsByTxHash.get(claimTx.tx_hash)!.push(asset);
            foundInClaim = true;
            this.logger.debug(`Asset ${asset.asset_id} found in claim tx ${claimTx.tx_hash}`);
            break; // Found the asset, no need to check other claim txs
          }
        } catch (error) {
          this.logger.warn(`Failed to fetch UTXO for claim tx ${claimTx.tx_hash}: ${error.message}`);
          continue;
        }
      }

      // If not found in any claim tx, check the original contribution tx
      if (!foundInClaim && asset.transaction?.tx_hash) {
        try {
          const contributionTxHash = asset.transaction.tx_hash;
          const txUtxos = await this.blockfrost.txsUtxos(contributionTxHash);

          const hasAssetInOutput = txUtxos.outputs.some(output => {
            const isAtScript = output.address === vault.contract_address;
            const hasThisAsset = output.amount.some((a: any) => a.unit === assetUnit);
            const notConsumed = !output.consumed_by_tx;

            return isAtScript && hasThisAsset && notConsumed;
          });

          if (hasAssetInOutput) {
            if (!assetsByTxHash.has(contributionTxHash)) {
              assetsByTxHash.set(contributionTxHash, []);
            }
            assetsByTxHash.get(contributionTxHash)!.push(asset);
            this.logger.debug(`Asset ${asset.asset_id} found in contribution tx ${contributionTxHash}`);
          } else {
            this.logger.error(`Asset ${asset.asset_id} not found in any UTXO (contribution tx: ${contributionTxHash})`);
          }
        } catch (error) {
          this.logger.warn(`Failed to fetch UTXO for contribution tx: ${error.message}`);
        }
      }
    }

    if (assetsByTxHash.size === 0) {
      throw new NotFoundException('No assets found in any UTXOs');
    }

    // 5. Find each UTXO and prepare extraction data
    const utxoGroups: UtxoGroup[] = [];
    const allExtractedAssets: ExtractionResult['extractedAssets'] = [];

    for (const [txHash, groupAssets] of assetsByTxHash.entries()) {
      this.logger.log(`Processing transaction ${txHash} with ${groupAssets.length} assets`);

      // Get UTXO details from Blockfrost
      const txUtxos = await this.blockfrost.txsUtxos(txHash);

      // Find the output with the contribution script address and the assets
      const contributionOutput = txUtxos.outputs.find(output => {
        const isAtScript = output.address === vault.contract_address;
        const hasAssets = output.amount.some(a =>
          groupAssets.some(asset => a.unit === `${asset.policy_id}${asset.asset_id}`)
        );
        const notConsumed = !output.consumed_by_tx;

        return isAtScript && hasAssets && notConsumed;
      });

      if (!contributionOutput) {
        this.logger.error(
          `UTXO not found for tx ${txHash}. Available outputs:`,
          txUtxos.outputs.map((o, idx) => ({
            index: idx,
            address: o.address.slice(0, 20) + '...',
            assetCount: o.amount.length - 1,
            consumed: !!o.consumed_by_tx,
          }))
        );
        throw new NotFoundException(`Contribution UTXO not found or already consumed in tx ${txHash}`);
      }

      // Extract assets from UTXO (excluding lovelace and receipt token)
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

      if (assetsToExtract.length === 0) {
        this.logger.warn(`No extractable assets in UTXO ${txHash}#${contributionOutput.output_index}`);
        continue;
      }

      utxoGroups.push({
        txHash,
        outputIndex: contributionOutput.output_index,
        assets: groupAssets,
        lovelace,
        assetsToExtract,
      });

      // Track all extracted assets
      groupAssets.forEach(asset => {
        allExtractedAssets.push({
          assetId: asset.id,
          policyId: asset.policy_id,
          assetName: asset.asset_id,
          contributionTxHash: txHash,
        });
      });
    }

    if (utxoGroups.length === 0) {
      throw new BadRequestException('No extractable UTXOs found');
    }

    // 6. Build transaction with multiple script interactions
    const treasuryAddress = config.treasuryAddress || this.adminAddress;

    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.extract,
      assets: [],
      metadata: {
        extractionType: 'treasury',
        utxoCount: utxoGroups.length,
        sourceTransactions: utxoGroups.map(g => g.txHash),
        assetCount: allExtractedAssets.length,
        assetIds: allExtractedAssets.map(a => a.assetId),
      },
    });

    // Build script interactions for each UTXO
    const scriptInteractions = utxoGroups.map(group => ({
      purpose: 'spend' as const,
      hash: vault.script_hash,
      outputRef: {
        txHash: group.txHash,
        index: group.outputIndex,
      },
      redeemer: {
        type: 'json' as const,
        value: {
          __variant: 'ExtractAsset',
          __data: {
            vault_token_output_index: null,
          },
        },
      },
    }));

    // Combine all assets to extract into a single output
    const allAssetsToExtract = utxoGroups.flatMap(g => g.assetsToExtract);
    const totalLovelace = utxoGroups.reduce((sum, g) => sum + BigInt(g.lovelace), BigInt(0)).toString();

    const input = {
      changeAddress: this.adminAddress,
      message: `Admin extract ${allAssetsToExtract.length} assets from ${utxoGroups.length} UTXOs to treasury`,
      scriptInteractions,
      outputs: [
        {
          address: treasuryAddress,
          lovelace: totalLovelace,
          assets: allAssetsToExtract,
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

    // Update all assets to EXTRACTED status
    const allAssetIds = utxoGroups.flatMap(g => g.assets.map(a => a.id));
    await this.assetsRepository.update({ id: In(allAssetIds) }, { status: AssetStatus.EXTRACTED });

    this.logger.log(`Successfully extracted ${allAssetIds.length} assets in transaction ${response.txHash}`);

    return {
      success: true,
      transactionId: transaction.id,
      extractedAssets: allExtractedAssets,
      treasuryAddress,
    };
  }
}
