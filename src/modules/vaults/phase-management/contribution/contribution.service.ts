import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ContributeReq } from './dto/contribute.req';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { BlockchainScannerService } from '@/modules/vaults/processing-tx/onchain/blockchain-scanner.service';
import { MetadataRegistryApiService } from '@/modules/vaults/processing-tx/onchain/metadata-register.service';
import { AssetStatus, AssetOriginType } from '@/types/asset.types';
import { BlockchainTransactionListItem } from '@/types/blockchain.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultPrivacy, VaultStatus } from '@/types/vault.types';

@Injectable()
export class ContributionService {
  private readonly logger = new Logger(ContributionService.name);
  private blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainScanner: BlockchainScannerService,
    private readonly configService: ConfigService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  /**
   * Syncs contribution transactions for a vault by comparing on-chain transactions
   * with the transactions stored in the database
   * @param vaultId - The ID of the vault to sync transactions for
   * @returns An object containing processed blockchain transactions and database transactions
   */
  async syncContributionTransactions(vaultId: string): Promise<{
    processedBlockchainTxs: Array<{
      tx: BlockchainTransactionListItem;
      dbTx: Transaction | null;
      statusUpdated: boolean;
    }>;
    databaseTxs: Transaction[];
  }> {
    try {
      // Get the vault with contract address
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'contract_address'],
      });

      if (!vault) {
        throw new NotFoundException('Vault not found');
      }

      if (!vault.contract_address) {
        throw new BadRequestException('Vault does not have a contract address');
      }

      // Get transactions from blockchain and process them
      const blockchainTxs = await this.blockchainScanner.getAddressTransactions(vault.contract_address);

      // Process blockchain transactions
      const processedBlockchainTxs = await Promise.all(
        blockchainTxs
          // Filter out transactions without block height
          .filter(tx => tx.block_height != null)
          ?.map(async tx => {
            // Find corresponding transaction in database
            const dbTx = await this.transactionRepository.findOne({
              where: { tx_hash: tx.tx_hash },
            });

            let statusUpdated = false;

            // If transaction exists in DB and status is not confirmed, update it
            if (dbTx && dbTx.status !== 'confirmed') {
              try {
                // Update the vault with the policy ID of Minted Token if it doesn't have one
                if (dbTx.type === TransactionType.contribute) {
                  const vault = await this.vaultRepository.findOne({
                    where: { id: vaultId },
                    select: [
                      'id',
                      'policy_id',
                      'asset_vault_name',
                      'name',
                      'description',
                      'ft_token_img',
                      'vault_token_ticker',
                    ],
                    relations: ['ft_token_img'],
                  });

                  if (vault && !vault.policy_id) {
                    const extractedPolicyId = await this.extractPolicyIdFromTransaction(tx.tx_hash);
                    if (extractedPolicyId) {
                      vault.policy_id = extractedPolicyId;
                      await this.vaultRepository.save(vault);

                      this.logger.log(`Updated vault ${vaultId} with policy ID: ${extractedPolicyId}`);
                      try {
                        this.logger.log(`Create PR to update Vault Metadata`);
                        await this.metadataRegistryApiService.submitTokenMetadata({
                          vaultId: vault.id,
                          subject: `${extractedPolicyId}${vault.asset_vault_name}`,
                          name: vault.name,
                          description: vault.description,
                          ticker: vault.vault_token_ticker,
                          logo: vault.ft_token_img.file_url,
                          decimals: 6,
                        });
                      } catch (error) {
                        this.logger.error('Error updating vault metadata:', error);
                      }
                    }
                  }
                }
              } catch (error) {
                this.logger.error(`Failed to extract policy ID for tx ${tx.tx_hash}`, error);
              }
              try {
                await this.transactionsService.updateTransactionStatus(
                  tx.tx_hash,
                  tx.tx_index,
                  TransactionStatus.confirmed
                );
                statusUpdated = true;
                this.logger.log(`Updated transaction ${tx.tx_hash} status to confirmed`);
              } catch (updateError) {
                this.logger.error(`Failed to update transaction ${tx.tx_hash} status`, updateError);
              }
            }

            return {
              tx,
              dbTx: dbTx || null,
              statusUpdated,
            };
          })
      );

      // Get all transactions from database for this vault
      const databaseTxs = await this.transactionRepository.find({
        where: {
          vault_id: vaultId,
          type: TransactionType.contribute,
        },
        order: {
          id: 'DESC' as const, // Using id as a proxy for creation order
        },
      });

      return {
        processedBlockchainTxs,
        databaseTxs,
      };
    } catch (error) {
      this.logger.error(`Failed to sync contribution transactions for vault ${vaultId}`, error);
      throw error;
    }
  }

  async contribute(
    vaultId: string,
    contributeReq: ContributeReq,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['contributor_whitelist', 'owner', 'assets_whitelist'],
    });
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Vault is not in contribution phase');
    }

    // For private/semi-private vaults, validate assets against whitelist
    if (
      (vault.privacy === VaultPrivacy.private || vault.privacy === VaultPrivacy.semiPrivate) &&
      contributeReq.assets.length > 0
    ) {
      const invalidAssets = contributeReq.assets.filter(asset => {
        return !vault.assets_whitelist?.some(whitelistedAsset => whitelistedAsset.policy_id === asset.policyId);
      });

      if (invalidAssets.length > 0) {
        throw new BadRequestException(
          `Some assets are not in the vault's whitelist: ${invalidAssets?.map(a => a.policyId).join(', ')}`
        );
      }
    }

    // Allow vault owner to bypass whitelist check
    if (vault.owner.id !== userId) {
      // Check whitelist only for non-owners
      if (vault.contributor_whitelist?.length > 0) {
        const isWhitelisted = vault.contributor_whitelist.some(entry => entry.wallet_address === user.address);
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in contributor whitelist');
        }
      }
    }
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.contribute,
      assets: [],
      userId,
    });
    if (contributeReq.assets.length > 0) {
      try {
        // First, ensure the transaction exists and is loaded with relations if needed
        const savedTransaction = await this.transactionRepository.findOneOrFail({
          where: { id: transaction.id },
          relations: ['assets'],
        });

        // Create and save all assets
        const assets = await Promise.all(
          contributeReq.assets?.map(async assetItem => {
            const asset = this.assetRepository.create({
              transaction: savedTransaction,
              type: assetItem.type,
              policy_id: assetItem.policyId || '',
              asset_id: assetItem.assetName,
              quantity: assetItem.quantity,
              status: AssetStatus.PENDING,
              origin_type: AssetOriginType.CONTRIBUTED,
              added_by: user,
              metadata: assetItem?.metadata || {},
            });

            const savedAsset = await this.assetRepository.save(asset);
            this.logger.log(`Created asset ${savedAsset.id} for transaction ${savedTransaction.id}`);
            return savedAsset;
          })
        );

        this.logger.log(`Successfully created ${assets.length} assets for transaction ${savedTransaction.id}`);
      } catch (error) {
        this.logger.error(`Failed to save assets for transaction ${transaction.id}`, error);
        throw new Error(`Failed to save contribution assets: ${error.message}`);
      }
    }
    return {
      success: true,
      message: 'Contribution request accepted, transaction created',
      vaultId,
      txId: transaction.id,
    };
  }

  /**
   * Extract the policy ID of Receipt from a transaction using its hash.
   * @param txHash The hash of the transaction.
   * @returns The extracted policy ID or null if not found.
   */
  private async extractPolicyIdFromTransaction(txHash: string): Promise<string | null> {
    try {
      const txUtxos = await this.blockfrost.txsUtxos(txHash);

      // Look for tokens containing "receipt" in the asset name (which gets hex encoded)
      const receiptHex = Buffer.from('receipt').toString('hex');
      this.logger.debug(`Looking for receipt tokens with hex suffix: ${receiptHex}`);

      for (const output of txUtxos.outputs) {
        for (const amount of output.amount) {
          if (amount.unit === 'lovelace') continue;
          if (amount.unit.endsWith(receiptHex)) {
            const policyId = amount.unit.slice(0, 56);
            this.logger.log(`Found receipt token with policy ID: ${policyId}`);
            return policyId;
          }
        }

        // If we have an inline datum, it might contain the policy ID
        if (output.inline_datum) {
          this.logger.debug('Checking inline datum for receipt info:', output.inline_datum);
          // Extract policy ID from datum if possible
          // This depends on your specific datum format
        }
      }

      // If no receipt token found, fall back to looking for any minted token
      const mintedTokens = [];
      txUtxos.outputs.forEach(output => {
        output.amount.forEach(amount => {
          if (amount.unit !== 'lovelace' && amount.quantity === '1') {
            const policyId = amount.unit.slice(0, 56);
            const assetName = amount.unit.slice(56);

            mintedTokens.push({
              policy_id: policyId,
              asset_name: assetName,
              quantity: amount.quantity,
            });
          }
        });
      });

      // Check if any token looks like a receipt
      for (const token of mintedTokens) {
        // Try to decode the asset name from hex
        try {
          const decodedName = Buffer.from(token.asset_name, 'hex').toString();
          if (decodedName.toLowerCase().includes('receipt')) {
            this.logger.log(`Found receipt token with policy ID: ${token.policy_id}`);
            return token.policy_id;
          }
        } catch (e) {}
      }

      // Last resort - just return first minted token
      if (mintedTokens.length > 0) {
        this.logger.warn(`No receipt token found, using first minted token policy: ${mintedTokens[0].policy_id}`);
        return mintedTokens[0].policy_id;
      }

      this.logger.warn(`No minted tokens found in transaction ${txHash}`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to extract policy ID from transaction ${txHash}`, error);
      return null;
    }
  }
}
