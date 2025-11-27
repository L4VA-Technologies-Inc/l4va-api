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
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { GetTransactionsDto } from '@/modules/vaults/processing-tx/offchain-tx/dto/get-transactions.dto';

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
    private readonly taptoolsService: TaptoolsService,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
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
          metadata: assetItem?.metadata || {},
        });
      });
    } else if (transaction.type === TransactionType.contribute) {
      pendingAssets.forEach(assetItem => {
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
          metadata: assetItem?.metadata || {},
        });
      });
    }

    // Bulk insert all assets in a single transaction
    if (assetsToCreate.length > 0) {
      await this.assetRepository.save(assetsToCreate);
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
    const { page, limit, status, period, filter = TransactionType.all, order = 'DESC', isExport = false } = query;

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
      case TransactionType.all:
        queryBuilder.andWhere('transaction.type IN (:...types)', {
          types: [TransactionType.contribute, TransactionType.burn, TransactionType.acquire],
        });
        break;
      case TransactionType.contribute:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.contribute,
        });
        break;
      case TransactionType.burn:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.burn,
        });
        break;
      case TransactionType.acquire:
        queryBuilder.andWhere('transaction.type = (:type)', {
          type: TransactionType.acquire,
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

  async updateTransactionHash(id: string, txHash: string): Promise<void> {
    const result = await this.transactionRepository.update(
      { id },
      {
        tx_hash: txHash,
        status: TransactionStatus.submitted,
      }
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Transaction with id ${id} not found`);
    }
  }

  async updateCreateVaultTransactionHashByVaultId(vaultId: string, txHash: string): Promise<void> {
    const result = await this.transactionRepository.update(
      {
        vault_id: vaultId,
        tx_hash: IsNull(),
        type: TransactionType.createVault,
      },
      {
        tx_hash: txHash,
        status: TransactionStatus.submitted,
      }
    );

    if (result.affected === 0) {
      throw new NotFoundException(`Transaction for vault id ${vaultId} not found`);
    }
  }

  async updateTransactionStatusById(id: string, status: TransactionStatus): Promise<void> {
    const result = await this.transactionRepository.update({ id }, { status });

    if (result.affected === 0) {
      this.logger.warn(`Transaction with id ${id} not found or status unchanged`);
    }
  }

  /**
   * Update transaction status by hash and optionally lock assets if they exist
   * @param txHash Transaction hash
   * @param txIndex Transaction index
   * @param status New transaction status
   * @returns Updated transaction or null if not found
   */
  async updateTransactionStatusAndLockAssets(
    txHash: string,
    txIndex: number,
    status: TransactionStatus
  ): Promise<Transaction | null> {
    const transaction = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (!transaction) {
      this.logger.warn(`Transaction with hash ${txHash} not found in database, skipping update`);
      return null;
    }

    // Update transaction status
    transaction.status = status;
    transaction.tx_index = txIndex.toString();

    const assets = await this.assetRepository.find({
      where: {
        transaction: { id: transaction.id },
      },
    });

    // Only lock assets if they exist
    if (assets.length > 0) {
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
        this.logger.warn(`Vault ${transaction.vault_id} not found for transaction ${txHash}`);
        return this.transactionRepository.save(transaction);
      }

      this.logger.log(`Locking ${assets.length} assets for transaction ${txHash}`);

      // Bulk update assets to LOCKED status
      await this.assetRepository.update(
        { transaction: { id: transaction.id } },
        {
          status: AssetStatus.LOCKED,
          vault: { id: vault.id },
        }
      );

      // Calculate and update vault values only if assets were locked
      const assetsPrices = await this.taptoolsService.calculateVaultAssetsValue(transaction.vault_id);

      vault.require_reserved_cost_ada = assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01);
      vault.require_reserved_cost_usd = assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01);
      vault.total_assets_cost_ada = assetsPrices.totalValueAda;
      vault.total_assets_cost_usd = assetsPrices.totalValueUsd;
      vault.total_acquired_value_ada = assetsPrices.totalAcquiredAda;

      await this.vaultRepository.update(vault.id, {
        require_reserved_cost_ada: vault.require_reserved_cost_ada,
        require_reserved_cost_usd: vault.require_reserved_cost_usd,
        total_assets_cost_ada: vault.total_assets_cost_ada,
        total_assets_cost_usd: vault.total_assets_cost_usd,
        total_acquired_value_ada: vault.total_acquired_value_ada,
      });
    } else {
      this.logger.log(`No assets found for transaction ${txHash}, skipping asset locking`);
    }

    return this.transactionRepository.save(transaction);
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
        await Promise.all(
          txsToUpdate.map(tx =>
            this.updateTransactionStatusAndLockAssets(tx.tx_hash, tx.tx_index, TransactionStatus.confirmed)
          )
        );
        this.logger.log(`Updated ${txsToUpdate.length} transactions to confirmed status`);
      } catch (error) {
        this.logger.error('Failed to update transaction statuses', error);
      }
    }
  }
}
