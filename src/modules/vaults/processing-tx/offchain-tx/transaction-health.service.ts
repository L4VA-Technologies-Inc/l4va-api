import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TransactionsService } from './transactions.service';

import { Transaction } from '@/database/transaction.entity';
import { TransactionStatus } from '@/types/transaction.types';

@Injectable()
export class TransactionHealthService {
  private readonly logger = new Logger(TransactionHealthService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly STUCK_TRANSACTION_TIMEOUT_MINUTES = 30;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  /**
   * Health check cron job that runs every 30 minutes
   * Checks for transactions stuck in 'submitted' status
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async checkStuckTransactions(): Promise<void> {
    this.logger.log('Starting health check for stuck transactions');

    try {
      const stuckThreshold = new Date();
      stuckThreshold.setMinutes(stuckThreshold.getMinutes() - this.STUCK_TRANSACTION_TIMEOUT_MINUTES);

      // Find transactions that are in 'submitted' status for more than 30 minutes
      const stuckTransactions = await this.transactionRepository
        .createQueryBuilder('transaction')
        .where('transaction.status = :status', { status: TransactionStatus.submitted })
        .andWhere('transaction.tx_hash IS NOT NULL')
        .andWhere('transaction.updated_at < :threshold', { threshold: stuckThreshold })
        .getMany();

      if (stuckTransactions.length === 0) {
        this.logger.log('No stuck transactions found');
        return;
      }

      this.logger.log(`Found ${stuckTransactions.length} potentially stuck transactions, verifying on-chain...`);

      const results = await Promise.allSettled(stuckTransactions.map(tx => this.verifyAndUpdateTransaction(tx)));

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      this.logger.log(`Health check completed: ${successful} transactions verified, ${failed} failed to verify`);
    } catch (error) {
      this.logger.error('Error during health check for stuck transactions', error);
    }
  }

  /**
   * Verify a transaction on-chain and update its status
   * @param transaction Transaction to verify
   */
  private async verifyAndUpdateTransaction(transaction: Transaction): Promise<void> {
    try {
      // Try to fetch transaction from blockchain
      const blockchainTx = await this.blockfrost.txs(transaction.tx_hash);

      if (blockchainTx && blockchainTx.block_height) {
        // Transaction is confirmed on-chain
        this.logger.log(
          `Transaction ${transaction.tx_hash} is confirmed on-chain (block: ${blockchainTx.block_height}), updating status`
        );

        await this.transactionsService.updateTransactionStatusAndLockAssets(
          transaction.tx_hash,
          blockchainTx.index,
          TransactionStatus.confirmed
        );
      } else {
        // Transaction exists but not yet in a block
        this.logger.warn(`Transaction ${transaction.tx_hash} found on-chain but not yet confirmed (no block height)`);
      }
    } catch (error) {
      // Transaction not found on-chain or other error
      if (error.status_code === 404) {
        this.logger.error(
          `Transaction ${transaction.tx_hash} not found on-chain after ${this.STUCK_TRANSACTION_TIMEOUT_MINUTES} minutes, marking as failed`
        );

        // Mark as failed if not found after timeout period
        await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      } else {
        this.logger.error(`Error verifying transaction ${transaction.tx_hash}:`, error.message);
        throw error;
      }
    }
  }

  /**
   * Manual trigger for health check (can be called via admin endpoint)
   */
  async triggerHealthCheck(): Promise<{
    message: string;
    checkedCount: number;
  }> {
    this.logger.log('Manual health check triggered');

    const stuckThreshold = new Date();
    stuckThreshold.setMinutes(stuckThreshold.getMinutes() - this.STUCK_TRANSACTION_TIMEOUT_MINUTES);

    const stuckTransactions = await this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.status = :status', { status: TransactionStatus.submitted })
      .andWhere('transaction.tx_hash IS NOT NULL')
      .andWhere('transaction.updated_at < :threshold', { threshold: stuckThreshold })
      .getMany();

    if (stuckTransactions.length === 0) {
      return {
        message: 'No stuck transactions found',
        checkedCount: 0,
      };
    }

    await Promise.allSettled(stuckTransactions.map(tx => this.verifyAndUpdateTransaction(tx)));

    return {
      message: `Health check completed for ${stuckTransactions.length} stuck transactions`,
      checkedCount: stuckTransactions.length,
    };
  }
}
