import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { AssetOriginType, AssetStatus, AssetType } from 'src/types/asset.types';
import { TransactionStatus, TransactionType } from 'src/types/transaction.types';
import { Repository } from 'typeorm';

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

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly taptoolsService: TaptoolsService
  ) {}

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

  async updateTransactionStatus(txHash: string, txIndex: number, status: TransactionStatus): Promise<Transaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (!transaction) {
      throw new Error(`Transaction with hash ${txHash} not found`);
    }

    const vault = await this.vaultRepository.findOne({
      where: {
        id: transaction.vault_id,
      },
    });

    const assets = await this.assetRepository.findBy({
      transaction: {
        id: transaction.id,
      },
    });

    assets.map(async item => {
      const asset = await this.assetRepository.findOne({
        where: {
          id: item.id,
        },
      });
      asset.vault = vault;
      asset.status = AssetStatus.LOCKED;
      await this.assetRepository.save(asset);
    });

    transaction.status = status;
    transaction.tx_index = txIndex.toString();

    const assetsPrices = await this.taptoolsService.calculateVaultAssetsValue(transaction.vault_id);

    vault.require_reserved_cost_ada = assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01);
    vault.require_reserved_cost_usd = assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01);
    vault.total_assets_cost_ada = assetsPrices.totalValueAda;
    vault.total_assets_cost_usd = assetsPrices.totalValueUsd;
    vault.total_acquired_value_ada = assetsPrices.totalAcquiredAda;

    await this.vaultRepository.save(vault);

    return this.transactionRepository.save(transaction);
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

  async findById(id: string): Promise<Transaction> {
    return this.transactionRepository.findOne({
      where: { id },
    });
  }

  async getByUserId(id: string, query: GetTransactionsDto): Promise<TransactionsResponseDto> {
    const { page = '1', limit = '10', filter = TransactionType.all, status, order = 'DESC', period } = query;

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
      .skip(skip)
      .take(parsedLimit);

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

    if (status) {
      queryBuilder.andWhere('transaction.status IN (:...statuses)', {
        statuses: status,
      });
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

  async updateTransactionHash(id: string, txHash: string): Promise<Transaction> {
    const transaction = await this.findById(id);
    if (!transaction) {
      throw new Error(`Transaction with id ${id} not found`);
    }

    transaction.tx_hash = txHash;
    transaction.status = TransactionStatus.pending;
    return await this.transactionRepository.save(transaction);
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

    if (transaction.type === TransactionType.acquire) {
      await Promise.all(
        pendingAssets.map(async assetItem => {
          const asset = this.assetRepository.create({
            transaction,
            vault: { id: transaction.vault_id },
            type: AssetType.ADA, // Using ADA type for acquire
            policy_id: assetItem.policyId || '',
            asset_id: assetItem.assetName,
            quantity: assetItem.quantity,
            status: AssetStatus.PENDING,
            origin_type: AssetOriginType.ACQUIRED,
            added_by: user,
            metadata: assetItem?.metadata || {},
          });

          await this.assetRepository.save(asset);
        })
      );
    } else if (transaction.type === TransactionType.contribute) {
      await Promise.all(
        pendingAssets.map(async assetItem => {
          const asset = this.assetRepository.create({
            transaction,
            vault: { id: transaction.vault_id },
            type: assetItem.type,
            policy_id: assetItem.policyId || '',
            asset_id: assetItem.assetName,
            quantity: assetItem.quantity,
            status: AssetStatus.PENDING,
            origin_type: AssetOriginType.CONTRIBUTED,
            added_by: user,
            metadata: assetItem?.metadata || {},
          });

          return this.assetRepository.save(asset);
        })
      );
    }

    return {
      success: true,
    };
  }
}
