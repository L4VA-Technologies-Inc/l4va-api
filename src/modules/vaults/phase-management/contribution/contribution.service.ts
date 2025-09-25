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
import { VaultStatus } from '@/types/vault.types';

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
   *
   * BUG: script_hash and policy_id are the same
   *
   * TODO: Handle where pr fails to submit, maybe retry later
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
        select: [
          'id',
          'policy_id',
          'asset_vault_name',
          'name',
          'script_hash',
          'description',
          'ft_token_img',
          'vault_token_ticker',
        ],
        relations: ['ft_token_img'],
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
              // Update the vault with the policy ID
              if (dbTx.type === TransactionType.contribute && !vault.policy_id) {
                try {
                  vault.policy_id = vault.script_hash;
                  await this.vaultRepository.save(vault);
                  try {
                    this.logger.log(`Create PR to update Vault Metadata`);
                    await this.metadataRegistryApiService.submitTokenMetadata({
                      vaultId: vault.id,
                      subject: `${vault.script_hash}${vault.asset_vault_name}`,
                      name: vault.name,
                      description: vault.description,
                      ticker: vault.vault_token_ticker,
                      logo: vault.ft_token_img?.file_url || '',
                      decimals: vault.ft_token_decimals || 6,
                    });
                  } catch (error) {
                    this.logger.error('Error updating vault metadata:', error);
                  }
                } catch (error) {
                  this.logger.error(`Failed to extract policy ID for tx ${tx.tx_hash}`, error);
                }
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

    // Check if adding these assets would exceed the vault's maximum capacity
    const currentAssetCountResult = await this.assetRepository
      .createQueryBuilder('asset')
      .select('SUM(asset.quantity)', 'totalQuantity')
      .where('asset.vault_id = :vaultId', { vaultId })
      .andWhere('asset.status = :status', { status: AssetStatus.LOCKED })
      .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
      .getRawOne();

    const currentAssetCount = Number(currentAssetCountResult?.totalQuantity || 0);

    if (currentAssetCount + contributeReq.assets.length > vault.max_contribute_assets) {
      throw new BadRequestException(
        `Adding ${contributeReq.assets.length} assets would exceed the vault's maximum capacity of ${vault.max_contribute_assets}. ` +
          `The vault currently has ${currentAssetCount} assets.`
      );
    }

    if (contributeReq.assets.length > 0) {
      // Group assets by policy ID to check against whitelist caps
      const assetsByPolicy = contributeReq.assets.reduce((acc, asset) => {
        if (!acc[asset.policyId]) {
          acc[asset.policyId] = [];
        }
        acc[asset.policyId].push(asset);
        return acc;
      }, {});

      // Check if any policy is not in the whitelist
      const invalidAssets = [];

      for (const policyId of Object.keys(assetsByPolicy)) {
        const whitelistedAsset = vault.assets_whitelist?.find(wa => wa.policy_id === policyId);

        if (!whitelistedAsset) {
          invalidAssets.push(policyId);
          continue;
        }

        const existingPolicyCountResult = await this.assetRepository
          .createQueryBuilder('asset')
          .select('SUM(asset.quantity)', 'totalQuantity')
          .where('asset.vault_id = :vaultId', { vaultId })
          .andWhere('asset.policy_id = :policyId', { policyId })
          .andWhere('asset.status = :status', { status: AssetStatus.LOCKED })
          .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
          .getRawOne();

        const existingPolicyCount = Number(existingPolicyCountResult?.totalQuantity || 0);
        const policyAssetsQuantity = assetsByPolicy[policyId].reduce(
          (total, asset) => total + (Number(asset.quantity) || 1),
          0
        );

        // Check if adding these assets would exceed the maximum for this policy
        if (
          whitelistedAsset.asset_count_cap_max !== null &&
          whitelistedAsset.asset_count_cap_max > 0 &&
          existingPolicyCount + policyAssetsQuantity > whitelistedAsset.asset_count_cap_max
        ) {
          throw new BadRequestException(
            `The vault already has ${existingPolicyCount} quantity for policy ${policyId}. ` +
              `Adding ${policyAssetsQuantity} more would exceed the maximum of ${whitelistedAsset.asset_count_cap_max}.`
          );
        }
      }

      if (invalidAssets.length > 0) {
        throw new BadRequestException(`Some assets are not in the vault's whitelist: ${invalidAssets.join(', ')}`);
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
}
