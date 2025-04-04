import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionStatus, TransactionType } from '../../types/transaction.types';
import { AssetsService } from '../assets/assets.service';

export enum OnchainTransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  NOT_FOUND = 'not_found'
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly assetsService: AssetsService
  ) {}

  private readonly config = {
    network: process.env.BLOCKCHAIN_NETWORK || 'testnet',
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  };

  async checkOnchainTransactionStatus(txId: string): Promise<OnchainTransactionStatus> {
    try {
      // TODO: Implement actual blockchain transaction status check
      // This is a placeholder implementation
      return OnchainTransactionStatus.PENDING;

    } catch (error) {
      console.error(`Failed to check transaction status for hash ${txId}:`, error);
      return OnchainTransactionStatus.NOT_FOUND;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkPendingTransactions() {
    this.logger.debug('Checking pending transactions...');

    try {
      // Get all pending transactions
      const pendingTransactions = await this.transactionsService.getTransactionsByStatus(TransactionStatus.pending);

      // Check each transaction's status on chain
      for (const transaction of pendingTransactions) {
        const status = await this.checkOnchainTransactionStatus(transaction.tx_hash);

        // Map blockchain status to transaction status
        let newStatus: TransactionStatus;
        switch (status) {
          case OnchainTransactionStatus.CONFIRMED:
            newStatus = TransactionStatus.confirmed;
            break;
          case OnchainTransactionStatus.FAILED:
            newStatus = TransactionStatus.failed;
            break;
          case OnchainTransactionStatus.NOT_FOUND:
            newStatus = TransactionStatus.stuck;
            break;
          default:
            // For PENDING status, do nothing
            continue;
        }

        // Update transaction status if changed
        await this.transactionsService.updateTransactionStatus(transaction.tx_hash, newStatus);
        this.logger.debug(`Updated transaction ${transaction.tx_hash} status to ${newStatus}`);

        // If transaction is confirmed and it's a contribution transaction, update the assets
        if (newStatus === TransactionStatus.confirmed && transaction.type === TransactionType.contribute) {
          try {
            await this.assetsService.updateTransactionAssets(transaction.id, transaction.vault_id);
            this.logger.debug(`Updated assets for transaction ${transaction.tx_hash}`);
          } catch (error) {
            this.logger.error(`Failed to update assets for transaction ${transaction.tx_hash}:`, error);
          }
        }
      }
    } catch (error) {
      this.logger.error('Error checking pending transactions:', error);
    }
  }
}
