import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../../database/transaction.entity';
import { TransactionStatus, TransactionType } from '../../types/transaction.types';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>
  ) {}

  async createTransaction(data: {
    sender: string;
    receiver: string;
    type: TransactionType;
    fee: number;
    txHash: string;
    block: number;
    metadata?: Record<string, any>;
  }): Promise<Transaction> {
    const transaction = this.transactionRepository.create({
      sender: data.sender,
      receiver: data.receiver,
      type: data.type,
      fee: data.fee,
      tx_hash: data.txHash,
      block: data.block,
      metadata: data.metadata,
      status: TransactionStatus.created
    });

    return this.transactionRepository.save(transaction);
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
      where: { sender: address },
      order: { block: 'DESC' }
    });
  }

  async getTransactionsByReceiver(address: string): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { receiver: address },
      order: { block: 'DESC' }
    });
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    return this.transactionRepository.findOne({
      where: { tx_hash: txHash }
    });
  }
}
