import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../../database/transaction.entity';
import { TransactionStatus, TransactionType } from '../../types/transaction.types';
import {Asset} from '../../database/asset.entity';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
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
      amount: data.amount
    });
  }

  async updateTransactionStatus(
    txHash: string,
    status: TransactionStatus
  ): Promise<Transaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { tx_hash: txHash }
    });

    if (!transaction) {
      throw new Error(`Transaction with hash ${txHash} not found`);
    }

    transaction.status = status;
    return this.transactionRepository.save(transaction);
  }

  async getTransactionsBySender(address: string): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { utxo_input: address },
      order: { id: 'DESC' }
    });
  }

  async validateTransactionExists(id: string): Promise<Transaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { id }
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
      relations: ['vault']
    });
  }

  async getTransactionsByReceiver(address: string): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { utxo_output: address },
      order: { id: 'DESC' }
    });
  }

  async findById(id: string): Promise<Transaction> {
    return this.transactionRepository.findOne({
      where: { id }
    });
  }

  async updateTransactionHash(id: string, txHash: string): Promise<Transaction> {
    const transaction = await this.findById(id);
    if (!transaction) {
      throw new Error(`Transaction with id ${id} not found`);
    }

    transaction.tx_hash = txHash;
    transaction.status = TransactionStatus.pending;
    return this.transactionRepository.save(transaction);
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    return this.transactionRepository.findOne({
      where: { tx_hash: txHash }
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
      relations: ['assets']
    });
  }

  async getInvestmentTransactions(vaultId?: string): Promise<Transaction[]> {
    const where: any = { type: TransactionType.investment };
    if (vaultId) {
      where.vault_id = vaultId;
    }

    return this.transactionRepository.find({
      where,
      order: { id: 'DESC' },
      relations: ['vault']
    });
  }
}
