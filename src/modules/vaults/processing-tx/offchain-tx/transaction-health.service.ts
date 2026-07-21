import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createPublicClient, http, PublicClient } from 'viem';

import { BlockchainWebhookService } from '../onchain/blockchain-webhook.service';

import { TransactionsService } from './transactions.service';

import { Transaction } from '@/database/transaction.entity';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class TransactionHealthService {
  private readonly logger = new Logger(TransactionHealthService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly evmClient?: PublicClient;
  private readonly STUCK_TRANSACTION_TIMEOUT_MINUTES = 3;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainWebhookService: BlockchainWebhookService,
    private readonly configService: ConfigService
  ) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });

    // Initialize EVM client
    const evmRpcUrl = this.configService.get<string>('EVM_RPC_URL');
    if (evmRpcUrl) {
      this.evmClient = createPublicClient({
        transport: http(evmRpcUrl),
      }) as PublicClient;
    }
  }

  /**
   * Health check cron job that runs every 30 minutes
   * Checks for transactions stuck in 'submitted' status
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
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
    // Determine if this is an EVM transaction
    if (this.isEvmTransaction(transaction)) {
      await this.verifyEvmTransaction(transaction);
    } else {
      await this.verifyCardanoTransaction(transaction);
    }
  }

  /**
   * Check if transaction is an EVM transaction
   * @param transaction Transaction to check
   */
  private isEvmTransaction(transaction: Transaction): boolean {
    // Check if chain_id is set (explicit EVM marker)
    if (transaction.chain_id !== null && transaction.chain_id !== undefined) {
      return true;
    }

    // Fallback: Check transaction hash format
    // EVM transactions start with 0x and are 66 characters long
    // Cardano transactions are typically 64 characters without 0x prefix
    if (transaction.tx_hash?.startsWith('0x')) {
      return true;
    }

    return false;
  }

  /**
   * Verify EVM transaction on-chain and update its status
   * @param transaction EVM transaction to verify
   */
  private async verifyEvmTransaction(transaction: Transaction): Promise<void> {
    if (!this.evmClient) {
      this.logger.error('EVM client not initialized. Please set EVM_RPC_URL in config');
      return;
    }

    try {
      // Get transaction receipt from EVM chain
      const receipt = await this.evmClient.getTransactionReceipt({
        hash: transaction.tx_hash as `0x${string}`,
      });

      if (receipt) {
        // Check if transaction was successful
        if (receipt.status === 'success') {
          this.logger.log(
            `EVM transaction ${transaction.tx_hash} is confirmed on-chain (block: ${receipt.blockNumber}), updating status`
          );

          // Use the same confirmation logic as the webhook (parses VaultCreated events + applies status)
          await this.blockchainWebhookService.applyEvmTransactionStatus(
            transaction.tx_hash,
            Number(receipt.transactionIndex),
            TransactionStatus.confirmed,
            receipt.logs.map(log => ({ topics: (log as any).topics ?? [], data: log.data }))
          );

          // Update block_number if not already set
          if (!transaction.block_number && receipt.blockNumber) {
            await this.transactionRepository.update(transaction.id, {
              block_number: Number(receipt.blockNumber),
            });
          }
        } else {
          // Transaction failed on-chain
          this.logger.error(
            `EVM transaction ${transaction.tx_hash} failed on-chain (block: ${receipt.blockNumber}), marking as failed`
          );
          await this.blockchainWebhookService.applyEvmTransactionStatus(
            transaction.tx_hash,
            Number(receipt.transactionIndex),
            TransactionStatus.failed,
            []
          );
        }
      } else {
        // Transaction exists but not yet mined
        this.logger.warn(`EVM transaction ${transaction.tx_hash} submitted but not yet mined`);
      }
    } catch (error) {
      // Transaction not found on-chain or other error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : '';

      if (errorMessage.includes('not found') || errorName === 'TransactionNotFoundError') {
        this.logger.error(
          `EVM transaction ${transaction.tx_hash} not found on-chain after ${this.STUCK_TRANSACTION_TIMEOUT_MINUTES} minutes, marking as failed`
        );
        await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      } else {
        this.logger.error(`Error verifying EVM transaction ${transaction.tx_hash}:`, errorMessage);
        throw error;
      }
    }
  }

  /**
   * Verify Cardano transaction on-chain and update its status
   * @param transaction Cardano transaction to verify
   */
  private async verifyCardanoTransaction(transaction: Transaction): Promise<void> {
    try {
      // Try to fetch transaction from blockchain
      const blockchainTx = await this.blockfrost.txs(transaction.tx_hash);

      if (blockchainTx && blockchainTx.block_height) {
        // Transaction is confirmed on-chain
        this.logger.log(
          `Cardano transaction ${transaction.tx_hash} is confirmed on-chain (block: ${blockchainTx.block_height}), updating status`
        );

        await this.transactionsService.updateTransactionStatusByHash(
          transaction.tx_hash,
          blockchainTx.index,
          TransactionStatus.confirmed
        );

        if (!transaction) {
          return null;
        }

        if (transaction.type === TransactionType.contribute || transaction.type === TransactionType.acquire) {
          const lockedCount = await this.transactionsService.lockAssetsForTransaction(transaction.id);
          this.logger.log(`Locked ${lockedCount} assets for transaction ${transaction.tx_hash}`);
        }
      } else {
        // Transaction exists but not yet in a block
        this.logger.warn(
          `Cardano transaction ${transaction.tx_hash} found on-chain but not yet confirmed (no block height)`
        );
      }
    } catch (error) {
      // Transaction not found on-chain or other error
      const statusCode = (error as any)?.status_code;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (statusCode === 404) {
        this.logger.error(
          `Cardano transaction ${transaction.tx_hash} not found on-chain after ${this.STUCK_TRANSACTION_TIMEOUT_MINUTES} minutes, marking as failed`
        );

        // Mark as failed if not found after timeout period
        await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      } else {
        this.logger.error(`Error verifying Cardano transaction ${transaction.tx_hash}:`, errorMessage);
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
