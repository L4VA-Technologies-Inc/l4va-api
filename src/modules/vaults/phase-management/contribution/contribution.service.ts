import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

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
    private readonly metadataRegistryApiService: MetadataRegistryApiService
  ) {}

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
      // Get the vault with all necessary fields in one query
      const vault = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: [
          'id',
          'policy_id',
          'contract_address',
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

      const vaultHasTxs = await this.transactionRepository.exists({
        where: {
          vault_id: vaultId,
          tx_hash: Not(IsNull()),
        },
      });

      if (!vaultHasTxs) {
        return;
      }

      // Get transactions from blockchain and process them
      const blockchainTxs = await this.blockchainScanner.getAddressTransactions(vault.contract_address);

      // Filter transactions we need to process
      const filteredTxs = blockchainTxs.filter(tx => tx.block_height != null);

      // If no transactions to process, return early
      if (filteredTxs.length === 0) {
        const databaseTxs = await this.transactionRepository.find({
          where: {
            vault_id: vaultId,
          },
          order: { id: 'DESC' },
        });

        return {
          processedBlockchainTxs: [],
          databaseTxs,
        };
      }

      const txHashes = filteredTxs.map(tx => tx.tx_hash);

      const dbTxs = await this.transactionRepository.find({
        where: { tx_hash: In(txHashes) },
      });

      // Create lookup map for faster access
      const dbTxMap = new Map(dbTxs.map(tx => [tx.tx_hash, tx]));

      // Collect transactions that need status updates
      const txsToUpdate: { tx_hash: string; tx_index: number }[] = [];

      const needsPolicyIdUpdate = !vault.policy_id;

      // Process each transaction
      const processedBlockchainTxs = filteredTxs.map(tx => {
        const dbTx = dbTxMap.get(tx.tx_hash) || null;
        let statusUpdated = false;

        // If transaction exists in DB and status is not confirmed, mark for update
        if (dbTx && dbTx.status !== TransactionStatus.confirmed) {
          // Mark for status update
          txsToUpdate.push({
            tx_hash: tx.tx_hash,
            tx_index: tx.tx_index,
          });

          statusUpdated = true;
        }

        return {
          tx,
          dbTx,
          statusUpdated,
        };
      });

      // If we need to update policy ID, do it once
      if (needsPolicyIdUpdate && txsToUpdate.length > 0) {
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
          this.logger.error(`Failed to update vault policy ID`, error);
        }
      }

      if (txsToUpdate.length > 0) {
        try {
          await Promise.all(
            txsToUpdate.map(tx =>
              this.transactionsService.updateTransactionStatus(tx.tx_hash, tx.tx_index, TransactionStatus.confirmed)
            )
          );
          this.logger.log(`Updated ${txsToUpdate.length} transactions to confirmed status`);
        } catch (error) {
          this.logger.error('Failed to update transaction statuses', error);
        }
      }

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
      .andWhere('asset.status IN (:...statuses)', { statuses: [AssetStatus.LOCKED, AssetStatus.PENDING] })
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
          .andWhere('asset.status IN (:...statuses)', { statuses: [AssetStatus.LOCKED, AssetStatus.PENDING] })
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
      metadata: contributeReq.assets,
    });

    return {
      success: true,
      message: 'Contribution request accepted, transaction created',
      vaultId,
      txId: transaction.id,
    };
  }
}
