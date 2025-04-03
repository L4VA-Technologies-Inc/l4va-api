import { Injectable } from '@nestjs/common';
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
    assets: Asset[]
  }): Promise<Transaction> {
    return this.transactionRepository.save({
      vault_id: data.vault_id,
      type: data.type,
      status: TransactionStatus.created,
      assets: data.assets
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

  async getTransactionsByStatus(status: TransactionStatus): Promise<Transaction[]> {
    return this.transactionRepository.find({
      where: { status },
      order: { id: 'DESC' }
    });
  }

  async getTransactionsByReceiver(address: string) {
    // return this.transactionRepository.find({
    //   where: { receiver: address },
    //   order: { block: 'DESC' }
    // });
    return null;
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    return this.transactionRepository.findOne({
      where: { tx_hash: txHash }
    });
  }
}
