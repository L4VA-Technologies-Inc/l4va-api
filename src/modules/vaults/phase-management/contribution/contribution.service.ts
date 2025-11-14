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
import { AssetStatus, AssetOriginType } from '@/types/asset.types';
import { BlockchainTransactionListItem } from '@/types/blockchain.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class ContributionService {
  private readonly logger = new Logger(ContributionService.name);
  private readonly PROTOCOL_CONTRIBUTORS_FEE = 2_000_000; // Should be 4 ADA contributeReq.assets.length * this.PROTOCOL_CONTRIBUTORS_FEE
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
    private readonly blockchainScanner: BlockchainScannerService
  ) {}

  /**
   * Syncs contribution transactions for a vault by comparing on-chain transactions
   * with the transactions stored in the database
   *
   * Make PR to update VT metadata if needed
   *
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
          status: Not(TransactionStatus.confirmed),
        },
      });

      if (!vaultHasTxs) {
        return {
          processedBlockchainTxs: [],
          databaseTxs: [],
        };
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
    const assetsByPolicy = contributeReq.assets.reduce(
      (acc, asset) => {
        if (!acc[asset.policyId]) {
          acc[asset.policyId] = [];
        }
        acc[asset.policyId].push(asset);
        return acc;
      },
      {} as Record<string, any[]>
    );

    const requestedPolicyIds = Object.keys(assetsByPolicy);

    const vaultQuery = this.vaultRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .where('vault.id = :vaultId', { vaultId })
      .select([
        'vault.id',
        'vault.vault_status',
        'vault.max_contribute_assets',
        'owner.id',
        'assets_whitelist.id',
        'assets_whitelist.policy_id',
        'assets_whitelist.asset_count_cap_max',
      ]);

    const vaultData = await vaultQuery.getOne();

    if (!vaultData) {
      throw new NotFoundException('Vault not found');
    }

    let currentAssetCount = 0;
    let policyCountMap = new Map<string, number>();

    if (requestedPolicyIds.length > 0) {
      const assetCountResults = await this.assetRepository
        .createQueryBuilder('asset')
        .select('COUNT(DISTINCT asset.id)', 'totalCount')
        .addSelect('asset.policy_id', 'policyId')
        .addSelect('COALESCE(SUM(asset.quantity), 0)', 'totalQuantity')
        .where('asset.vault_id = :vaultId', { vaultId })
        .andWhere('asset.status IN (:...statuses)', {
          statuses: [AssetStatus.LOCKED, AssetStatus.PENDING],
        })
        .andWhere('asset.origin_type = :originType', {
          originType: AssetOriginType.CONTRIBUTED,
        })
        .groupBy('asset.policy_id')
        .getRawMany();

      currentAssetCount = assetCountResults.reduce((total, row) => {
        return total + Number(row.totalQuantity || 0);
      }, 0);

      const filteredPolicyResults = assetCountResults.filter(row => requestedPolicyIds.includes(row.policyId));

      policyCountMap = new Map(filteredPolicyResults.map(row => [row.policyId, Number(row.totalQuantity || 0)]));
    }

    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'address'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (vaultData.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Vault is not in contribution phase');
    }

    if (currentAssetCount + contributeReq.assets.length > vaultData.max_contribute_assets) {
      throw new BadRequestException(
        `Adding ${contributeReq.assets.length} assets would exceed the vault's maximum capacity of ${vaultData.max_contribute_assets}. ` +
          `The vault currently has ${currentAssetCount} assets.`
      );
    }

    // Check contributor whitelist
    if (vaultData.owner.id !== userId) {
      const vaultWithWhitelist = await this.vaultRepository
        .createQueryBuilder('vault')
        .leftJoinAndSelect('vault.contributor_whitelist', 'whitelist')
        .where('vault.id = :vaultId', { vaultId })
        .getOne();

      if (vaultWithWhitelist?.contributor_whitelist?.length > 0) {
        const isWhitelisted = vaultWithWhitelist.contributor_whitelist.some(
          entry => entry.wallet_address === user.address
        );
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in contributor whitelist');
        }
      }
    }

    if (contributeReq.assets.length > 0) {
      const invalidAssets: string[] = [];
      const policyExceedsLimit: Array<{
        policyId: string;
        existing: number;
        adding: number;
        max: number;
      }> = [];

      for (const policyId of requestedPolicyIds) {
        const whitelistedAsset = vaultData.assets_whitelist?.find(wa => wa.policy_id === policyId);

        if (!whitelistedAsset) {
          invalidAssets.push(policyId);
          continue;
        }

        const existingPolicyCount = policyCountMap.get(policyId) || 0;
        const policyAssetsQuantity = assetsByPolicy[policyId].reduce(
          (total, asset) => total + (Number(asset.quantity) || 1),
          0
        );

        if (
          whitelistedAsset.asset_count_cap_max !== null &&
          whitelistedAsset.asset_count_cap_max > 0 &&
          existingPolicyCount + policyAssetsQuantity > whitelistedAsset.asset_count_cap_max
        ) {
          policyExceedsLimit.push({
            policyId,
            existing: existingPolicyCount,
            adding: policyAssetsQuantity,
            max: whitelistedAsset.asset_count_cap_max,
          });
        }
      }

      if (invalidAssets.length > 0) {
        throw new BadRequestException(`Some assets are not in the vault's whitelist: ${invalidAssets.join(', ')}`);
      }

      if (policyExceedsLimit.length > 0) {
        const errorMessages = policyExceedsLimit.map(
          policy =>
            `Policy ${policy.policyId}: has ${policy.existing}, adding ${policy.adding} would exceed max ${policy.max}`
        );
        throw new BadRequestException(`Policy limits exceeded: ${errorMessages.join('; ')}`);
      }
    }

    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.contribute,
      assets: [],
      userId,
      fee: this.PROTOCOL_CONTRIBUTORS_FEE,
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
