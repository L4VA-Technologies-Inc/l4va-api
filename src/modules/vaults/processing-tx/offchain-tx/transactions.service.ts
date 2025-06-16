import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Asset } from 'src/database/asset.entity';
import { Transaction } from 'src/database/transaction.entity';
import { Vault } from 'src/database/vault.entity';
import { AssetStatus } from '../../../../types/asset.types';
import { TransactionStatus, TransactionType } from '../../../../types/transaction.types';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>
  ) {}

  async createTransaction(data: {
    vault_id: string;
    type: TransactionType;
    assets: Asset[];
    amount?: number;
  }): Promise<Transaction> {
    return this.transactionRepository.save({
      vault_id: data.vault_id,
      type: data.type,
      status: TransactionStatus.created,
      assets: data.assets,
      amount: data.amount,
    });
  }

  async updateTransactionStatus(txHash: string, status: TransactionStatus): Promise<Transaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });
    console.log('tx', transaction);

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
}
