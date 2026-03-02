import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config/dist/config.service';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { AssetOriginType, AssetStatus, AssetType } from 'src/types/asset.types';
import { TransactionStatus, TransactionType } from 'src/types/transaction.types';
import { In, IsNull, Not, Repository } from 'typeorm';

import { TransactionsResponseDto, TransactionsResponseItemsDto } from './dto/transactions-response.dto';

import { Asset } from '@/database/asset.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { GoogleCloudStorageService } from '@/modules/google_cloud/google_bucket/bucket.service';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import {
  GetTransactionsDto,
  GetTransactionType,
} from '@/modules/vaults/processing-tx/offchain-tx/dto/get-transactions.dto';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly taptoolsService: TaptoolsService,
    private readonly configService: ConfigService,
    private readonly gcsService: GoogleCloudStorageService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async createTransaction(data: {
    vault_id: string;
    type: TransactionType;
    assets: Asset[];
    amount?: number;
    userId?: string;
    fee?: number;
    metadata?: object;
  }): Promise<Transaction> {
    return this.transactionRepository.save({
      vault_id: data.vault_id,
      type: data.type,
      status: TransactionStatus.created,
      assets: data.assets,
      amount: data.amount,
      user_id: data.userId,
      fee: data.fee,
      metadata: data.metadata,
    });
  }

  async createAssets(txId: string): Promise<{ success: boolean }> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: txId },
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    const pendingAssets = transaction.metadata || [];

    // If everything is ok, create the actual assets and update transaction status
    const user = await this.usersRepository.findOne({
      where: { id: transaction.user_id },
    });

    if (!user) {
      throw new NotFoundException('User not found for the transaction');
    }

    const assetsToCreate: Partial<Asset>[] = [];

    if (transaction.type === TransactionType.acquire) {
      pendingAssets.forEach(assetItem => {
        assetsToCreate.push({
          transaction,
          vault: { id: transaction.vault_id } as Vault,
          type: AssetType.ADA, // Using ADA type for acquire
          policy_id: assetItem.policyId || '',
          asset_id: assetItem.assetName,
          quantity: assetItem.quantity,
          status: AssetStatus.PENDING,
          origin_type: AssetOriginType.ACQUIRED,
          added_by: user,
        });
      });
    } else if (transaction.type === TransactionType.contribute) {
      // Fetch on-chain metadata for all NFT/FT assets in parallel
      const metadataPromises = pendingAssets.map(async assetItem => {
        if (assetItem.type === AssetType.ADA) {
          return { assetItem, blockfrostMetadata: null };
        }

        // If frontend already provided good metadata with name, use it
        if (assetItem.metadata?.onchainMetadata?.name || assetItem.metadata?.name) {
          return { assetItem, blockfrostMetadata: null };
        }

        // Otherwise fetch from Blockfrost
        try {
          const unit = assetItem.policyId + assetItem.assetName;
          const assetInfo = await this.blockfrost.assetsById(unit);
          return { assetItem, blockfrostMetadata: assetInfo };
        } catch (error) {
          this.logger.warn(
            `Failed to fetch metadata for ${assetItem.policyId}${assetItem.assetName}: ${error.message}`
          );
          return { assetItem, blockfrostMetadata: null };
        }
      });

      const metadataResults = await Promise.all(metadataPromises);

      metadataResults.forEach(({ assetItem, blockfrostMetadata }) => {
        // Decode hex asset name to readable string as fallback
        let decodedName: string | null = null;
        try {
          decodedName = assetItem.assetName ? Buffer.from(assetItem.assetName, 'hex').toString('utf8') : null;
        } catch (error) {
          decodedName = assetItem.assetName || null;
        }

        // Priority: frontend displayName > frontend metadata > blockfrost metadata > decoded hex
        const finalName =
          assetItem.displayName ||
          assetItem.metadata?.onchainMetadata?.name ||
          assetItem.metadata?.name ||
          (blockfrostMetadata?.onchain_metadata as any)?.name ||
          (blockfrostMetadata as any)?.asset_name ||
          decodedName ||
          null;

        const finalImage =
          assetItem.image ||
          assetItem.metadata?.image ||
          assetItem.metadata?.files?.[0]?.src ||
          (blockfrostMetadata?.onchain_metadata as any)?.image ||
          null;

        const finalDescription =
          assetItem.description ||
          assetItem.metadata?.onchainMetadata?.description ||
          assetItem.metadata?.description ||
          (blockfrostMetadata?.onchain_metadata as any)?.description ||
          null;

        // Use prices from frontend if provided, otherwise will be fetched later
        const floorPrice = assetItem.type === AssetType.NFT ? assetItem.priceAda : null;
        const dexPrice = assetItem.type === AssetType.FT ? assetItem.priceAda : null;

        assetsToCreate.push({
          transaction,
          vault: { id: transaction.vault_id } as Vault,
          type: assetItem.type,
          policy_id: assetItem.policyId || '',
          asset_id: assetItem.assetName,
          quantity: assetItem.quantity,
          status: AssetStatus.PENDING,
          origin_type: AssetOriginType.CONTRIBUTED,
          added_by: user,
          image: finalImage,
          decimals:
            assetItem.decimals ??
            assetItem.metadata?.decimals ??
            (blockfrostMetadata?.metadata as any)?.decimals ??
            null,
          name: finalName,
          description: finalDescription,
          floor_price: floorPrice,
          dex_price: dexPrice,
          last_valuation: floorPrice || dexPrice ? new Date() : null,
        });
      });
    }

    // Bulk insert all assets in a single transaction
    if (assetsToCreate.length > 0) {
      await Promise.allSettled(
        assetsToCreate.map(async asset => {
          if (asset.image) {
            const fileKey = await this.gcsService.uploadAssetImage(asset.image);

            if (fileKey) {
              asset.image = fileKey;
            }
          }
        })
      );

      await this.assetRepository.save(assetsToCreate);

      // Clear metadata after successful asset creation
      await this.transactionRepository.update({ id: transaction.id }, { metadata: null });
    }

    return {
      success: true,
    };
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    return this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });
  }

  async getContributionTransactions(vaultId?: string): Promise<Transaction[]> {
    const where: any = { type: TransactionType.contribute };
    if (vaultId) {
      where.vault_id = vaultId;
    }

    return this.transactionRepository.find({
      where,
      order: { id: 'DESC' },
      relations: ['assets'],
    });
  }

  async getAcquireTransactions(vaultId?: string): Promise<Transaction[]> {
    const where: any = { type: TransactionType.acquire };
    if (vaultId) {
      where.vault_id = vaultId;
    }

    return this.transactionRepository.find({
      where,
      order: { id: 'DESC' },
      relations: ['vault'],
    });
  }

  async getVaultTransactions(
    vaultId: string,
    status?: TransactionStatus,
    type?: TransactionType
  ): Promise<Transaction[]> {
    const where: any = { vault_id: vaultId };
    if (status) {
      where.status = status;
    }
    if (type) {
      where.type = type;
    }

    return this.transactionRepository.find({
      where,
      order: { id: 'DESC' },
      relations: ['vault', 'assets'],
    });
  }

  /**
   * Get the last update transaction for a vault
   * @param vaultId The ID of the vault
   * @returns The most recent update transaction or null if none found
   */
  async getLastVaultUpdate(vaultId: string): Promise<Transaction | null> {
    const transactions = await this.transactionRepository.find({
      where: {
        vault_id: vaultId,
      },
      order: { id: 'DESC' },
      take: 1,
    });

    return transactions.length > 0 ? transactions[0] : null;
  }

  async getTransactionsBySender(address: string): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { utxo_input: address },
      order: { id: 'DESC' },
    });
  }

  /**
   * Wait for a transaction to reach a specific status by polling the database
   * Uses the webhook-updated transaction status instead of polling the blockchain
   *
   * @param transactionId - The internal transaction ID to monitor
   * @param targetStatus - The status to wait for (e.g., TransactionStatus.confirmed)
   * @param maxWaitTime - Maximum time to wait in milliseconds (default: 2 minutes)
   * @param checkInterval - Interval between checks in milliseconds (default: 5 seconds)
   * @returns Promise<boolean> - true if status reached, false if timeout
   */
  async waitForTransactionStatus(
    transactionId: string,
    targetStatus: TransactionStatus,
    maxWaitTime: number = 120000,
    checkInterval: number = 5000
  ): Promise<boolean> {
    const startTime = Date.now();
    this.logger.log(`Waiting for transaction ${transactionId} to reach status: ${targetStatus}`);

    while (Date.now() - startTime < maxWaitTime) {
      const transaction = await this.transactionRepository.findOne({
        where: { id: transactionId },
        select: ['id', 'status', 'tx_hash'],
      });

      if (!transaction) {
        this.logger.warn(`Transaction ${transactionId} not found in database`);
        return false;
      }

      if (transaction.status === targetStatus) {
        this.logger.log(`Transaction ${transactionId} reached status: ${targetStatus}`);
        return true;
      }

      if (transaction.status === TransactionStatus.failed) {
        this.logger.error(`Transaction ${transactionId} failed`);
        return false;
      }

      if (transaction.status === TransactionStatus.stuck) {
        this.logger.error(`Transaction ${transactionId} is stuck`);
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    this.logger.warn(`Transaction ${transactionId} status check timeout after ${maxWaitTime / 1000} seconds`);
    return false;
  }

  async validateTransactionExists(id: string): Promise<Transaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Outchain transaction with ID ${id} not found`);
    }

    return transaction;
  }

  async getTransactionsByStatus(status: TransactionStatus): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { status },
      order: { id: 'DESC' },
      relations: ['vault'],
    });
  }

  async getTransactionsByReceiver(address: string): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { utxo_output: address },
      order: { id: 'DESC' },
    });
  }

  async getByUserId(id: string, query: GetTransactionsDto): Promise<TransactionsResponseDto> {
    const { page, limit, status, period, filter = GetTransactionType.all, order = 'DESC', isExport = false } = query;

    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    const skip = (parsedPage - 1) * parsedLimit;

    const queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.vault', 'vault')
      .select([
        'transaction.id',
        'transaction.type',
        'transaction.status',
        'transaction.amount',
        'transaction.metadata',
        'transaction.tx_hash',
        'transaction.updated_at',
        'transaction.created_at',
        'transaction.vault_id',
        'vault.id',
        'vault.name',
      ])
      .where('transaction.user_id = :id', { id })
      .skip(skip);

    if (!isExport) {
      queryBuilder.take(parsedLimit);
    }

    const baseStatuses = [TransactionStatus.confirmed, TransactionStatus.pending];

    queryBuilder.andWhere('transaction.status IN (:...statuses)', {
      statuses: status ?? baseStatuses,
    });

    switch (filter) {
      case GetTransactionType.all:
        queryBuilder.andWhere('transaction.type IN (:...types)', {
          types: [
            TransactionType.contribute,
            TransactionType.burn,
            TransactionType.acquire,
            TransactionType.extractDispatch,
            TransactionType.claim,
          ],
        });
        break;
      case GetTransactionType.contribute:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.contribute,
        });
        break;
      case GetTransactionType.burn:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.burn,
        });
        break;
      case GetTransactionType.acquire:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.acquire,
        });
        break;
      case GetTransactionType.createVault:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.createVault,
        });
        break;
      case GetTransactionType.distribution:
        queryBuilder.andWhere('transaction.type IN (:...types)', {
          types: [TransactionType.extractDispatch, TransactionType.claim],
        });
        break;
    }

    if (period?.from && period?.to) {
      queryBuilder.andWhere('transaction.created_at BETWEEN :from AND :to', {
        from: new Date(period.from),
        to: new Date(period.to),
      });
    } else if (period?.from) {
      queryBuilder.andWhere('transaction.created_at >= :from', { from: new Date(period.from) });
    } else if (period?.to) {
      queryBuilder.andWhere('transaction.created_at <= :to', { to: new Date(period.to) });
    }

    if (order) {
      queryBuilder.orderBy('transaction.created_at', order);
    }

    const [transactions, total] = await queryBuilder.getManyAndCount();

    const items = plainToInstance(TransactionsResponseItemsDto, transactions, {
      excludeExtraneousValues: true,
    });

    return { items, total, page: parsedPage, limit: parsedLimit };
  }

  async updateTransactionHash(id: string, txHash: string, metadata?: Record<string, any>): Promise<void> {
    const result = await this.transactionRepository.update(
      { id },
      {
        tx_hash: txHash,
        status: TransactionStatus.submitted,
        metadata,
      }
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Transaction with id ${id} not found`);
    }
  }

  async updateTransactionStatusById(id: string, status: TransactionStatus): Promise<void> {
    const result = await this.transactionRepository.update({ id }, { status });

    if (result.affected === 0) {
      this.logger.warn(`Transaction with id ${id} not found or status unchanged`);
    }
  }

  /**
   * Update transaction status by hash
   * @param txHash Transaction hash
   * @param txIndex Transaction index
   * @param status New transaction status
   * @returns Updated transaction or null if not found
   */
  async updateTransactionStatusByHash(
    txHash: string,
    txIndex: number,
    status: TransactionStatus
  ): Promise<Transaction | null> {
    const transaction = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (!transaction) {
      this.logger.warn(`Transaction with hash ${txHash} not found during status update`);
      return null;
    }

    // Update transaction status
    transaction.status = status;
    transaction.tx_index = txIndex.toString();

    return this.transactionRepository.save(transaction);
  }

  /**
   * Lock assets for a confirmed transaction and update vault values
   * Only locks assets that are still pending to prevent double locking
   * Invalidates user wallet cache to ensure they see updated asset list
   * @param transactionId Transaction ID
   * @returns Number of assets locked
   */
  async lockAssetsForTransaction(transactionId: string): Promise<number> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId },
      select: ['id', 'vault_id', 'tx_hash'],
      relations: ['user'],
    });

    if (!transaction) {
      this.logger.warn(`Transaction ${transactionId} not found`);
      return 0;
    }

    if (transaction.user?.address) {
      this.taptoolsService.invalidateWalletCache(transaction.user.address);
    }

    const assets = await this.assetRepository.find({
      where: {
        transaction: { id: transaction.id },
        status: AssetStatus.PENDING, // Only lock pending assets
        deleted: false,
      },
    });

    // No assets to lock
    if (assets.length === 0) {
      this.logger.log(`No pending assets found for transaction ${transaction.tx_hash}`);
      return 0;
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: transaction.vault_id },
      select: [
        'id',
        'acquire_reserve',
        'require_reserved_cost_ada',
        'require_reserved_cost_usd',
        'total_assets_cost_ada',
        'total_assets_cost_usd',
        'total_acquired_value_ada',
      ],
    });

    if (!vault) {
      this.logger.warn(`Vault ${transaction.vault_id} not found for transaction ${transaction.tx_hash}`);
      return 0;
    }

    this.logger.log(`Locking ${assets.length} assets for transaction ${transaction.tx_hash}`);

    // Bulk update assets to LOCKED status
    const now = new Date();
    await this.assetRepository.update(
      {
        transaction: { id: transaction.id },
        status: AssetStatus.PENDING,
        deleted: false,
      },
      {
        status: AssetStatus.LOCKED,
        locked_at: now,
        updated_at: now,
      }
    );

    // Calculate and update vault values
    const assetsPrices = await this.taptoolsService.getVaultAssetsSummary(transaction.vault_id);

    await this.vaultRepository.update(vault.id, {
      require_reserved_cost_ada: assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01),
      require_reserved_cost_usd: assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01),
      total_assets_cost_ada: assetsPrices.totalValueAda,
      total_assets_cost_usd: assetsPrices.totalValueUsd,
      total_acquired_value_ada: assetsPrices.totalAcquiredAda,
    });

    // Update expansion proposal asset count if vault is in expansion
    await this.updateExpansionProposalAssetCount(transaction.vault_id);

    return assets.length;
  }

  /**
   * Batch lock assets for multiple transactions
   * More efficient than locking one by one
   * @param transactionIds Array of transaction IDs
   * @returns Total number of assets locked
   */
  async lockAssetsForTransactions(transactionIds: string[]): Promise<number> {
    if (transactionIds.length === 0) {
      return 0;
    }

    const transactions = await this.transactionRepository.find({
      where: { id: In(transactionIds) },
      select: ['id', 'vault_id', 'tx_hash', 'type'],
    });

    if (transactions.length === 0) {
      this.logger.warn(`No transactions found for IDs: ${transactionIds.join(', ')}`);
      return 0;
    }

    let totalLocked = 0;

    // Group transactions by vault for efficient processing
    const transactionsByVault = transactions.reduce(
      (acc, tx) => {
        if (!acc[tx.vault_id]) {
          acc[tx.vault_id] = [];
        }
        acc[tx.vault_id].push(tx);
        return acc;
      },
      {} as Record<string, typeof transactions>
    );

    // Process each vault's transactions
    for (const [vaultId, vaultTransactions] of Object.entries(transactionsByVault)) {
      const txIds = vaultTransactions.map(t => t.id);

      // Bulk lock all pending assets for these transactions
      const result = await this.assetRepository.update(
        {
          transaction: { id: In(txIds) },
          status: AssetStatus.PENDING,
          deleted: false,
        },
        {
          status: AssetStatus.LOCKED,
          locked_at: new Date(),
          updated_at: new Date(),
        }
      );

      const lockedCount = result.affected || 0;
      totalLocked += lockedCount;

      if (lockedCount > 0) {
        this.logger.log(
          `Locked ${lockedCount} assets for ${vaultTransactions.length} transactions in vault ${vaultId}`
        );

        // Update vault values once per vault
        const vault = await this.vaultRepository.findOne({
          where: { id: vaultId },
          select: ['id', 'acquire_reserve'],
        });

        if (vault) {
          const assetsPrices = await this.taptoolsService.getVaultAssetsSummary(vaultId);

          await this.vaultRepository.update(vault.id, {
            require_reserved_cost_ada: assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01),
            require_reserved_cost_usd: assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01),
            total_assets_cost_ada: assetsPrices.totalValueAda,
            total_assets_cost_usd: assetsPrices.totalValueUsd,
            total_acquired_value_ada: assetsPrices.totalAcquiredAda,
          });
        }
      }
    }

    return totalLocked;
  }

  /**
   * Syncs contribution transactions for a vault by comparing on-chain transactions
   * with the transactions stored in the database
   *
   * @param vaultId The ID of the vault
   * @returns
   */
  async syncVaultTransactions(vaultId: string): Promise<void> {
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

    if (!vault || !vault.contract_address) {
      throw new NotFoundException('Vault not found or missing contract address');
    }

    const vaultHasTxs = await this.transactionRepository.exists({
      where: {
        vault_id: vaultId,
        tx_hash: Not(IsNull()),
        status: Not(TransactionStatus.confirmed),
      },
    });

    if (!vaultHasTxs) {
      return;
    }

    const blockchainTxs = await this.blockfrost.addressesTransactionsAll(vault.contract_address, {
      order: 'asc',
    });

    const filteredTxs = blockchainTxs.filter(tx => tx.block_height != null);

    // If no transactions to process, return early
    if (filteredTxs.length === 0) {
      return;
    }
    const txHashes = filteredTxs.map(tx => tx.tx_hash);

    const dbTxs = await this.transactionRepository.find({
      where: { tx_hash: In(txHashes) },
    });

    // Create lookup map for faster access
    const dbTxMap = new Map(dbTxs.map(tx => [tx.tx_hash, tx]));
    // Collect transactions that need status updates
    const txsToUpdate: { tx_hash: string; tx_index: number }[] = [];

    filteredTxs.map(tx => {
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
        for (const tx of txsToUpdate) {
          const transaction = await this.updateTransactionStatusByHash(
            tx.tx_hash,
            tx.tx_index,
            TransactionStatus.confirmed
          );

          if (!transaction) {
            return null;
          }

          if (transaction.type === TransactionType.contribute || transaction.type === TransactionType.acquire) {
            const lockedCount = await this.lockAssetsForTransaction(transaction.id);
            this.logger.log(`Locked ${lockedCount} assets for transaction ${tx.tx_hash}`);
          }
        }
        this.logger.log(`Updated ${txsToUpdate.length} transactions to confirmed status`);
      } catch (error) {
        this.logger.error('Failed to update transaction statuses', error);
      }
    }
  }

  async countConfirmedContributions(vaultId: string): Promise<number> {
    return this.transactionRepository.count({
      where: {
        vault_id: vaultId,
        type: TransactionType.contribute,
        status: TransactionStatus.confirmed,
      },
    });
  }

  private async updateExpansionProposalAssetCount(vaultId: string): Promise<void> {
    try {
      // Check if vault is in expansion status
      const vault: Pick<Vault, 'id' | 'vault_status' | 'expansion_phase_start'> = await this.vaultRepository.findOne({
        where: { id: vaultId },
        select: ['id', 'vault_status', 'expansion_phase_start'],
      });

      if (!vault || vault.vault_status !== VaultStatus.expansion) {
        // Not in expansion mode, nothing to update
        return;
      }

      // Find the active expansion proposal
      const expansionProposal: Pick<Proposal, 'id' | 'metadata' | 'executionDate'> =
        await this.proposalRepository.findOne({
          where: {
            vaultId,
            proposalType: ProposalType.EXPANSION,
            status: ProposalStatus.EXECUTED,
          },
          order: { executionDate: 'DESC' },
          select: ['id', 'metadata', 'executionDate'],
        });

      if (!expansionProposal || !expansionProposal.metadata?.expansion) {
        this.logger.warn(`No active expansion proposal found for vault ${vaultId}`);
        return;
      }

      // Count locked expansion assets (contributed during expansion)
      // NFTs counted by record count, FTs counted by quantity sum
      const expansionAssetData = await this.assetRepository
        .createQueryBuilder('asset')
        .select('asset.type', 'assetType')
        .addSelect('COUNT(DISTINCT asset.id)', 'nftCount')
        .addSelect('COALESCE(SUM(asset.quantity), 0)', 'ftQuantity')
        .where('asset.vault_id = :vaultId', { vaultId })
        .andWhere('asset.status = :status', { status: AssetStatus.LOCKED })
        .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
        .andWhere('asset.locked_at >= :expansionStart', { expansionStart: vault.expansion_phase_start })
        .groupBy('asset.type')
        .getRawMany();

      const currentAssetCount = expansionAssetData.reduce((total, row) => {
        const quantity = row.assetType === AssetType.NFT ? Number(row.nftCount) : Number(row.ftQuantity);
        return total + quantity;
      }, 0);

      // Update proposal metadata
      expansionProposal.metadata.expansion.currentAssetCount = currentAssetCount;

      await this.proposalRepository.update({ id: expansionProposal.id }, { metadata: expansionProposal.metadata });

      this.logger.log(`Updated expansion asset count for vault ${vaultId}: ${currentAssetCount}`);
    } catch (error) {
      this.logger.error(`Failed to update expansion asset count for vault ${vaultId}:`, error);
      // Don't throw - this is a secondary operation that shouldn't fail the main transaction
    }
  }
}
