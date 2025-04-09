import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionStatus, TransactionType } from '../../types/transaction.types';
import { AssetsService } from '../assets/assets.service';
import { BlockchainScannerService } from './blockchain-scanner.service';

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
    private readonly assetsService: AssetsService,
    private readonly scannerService: BlockchainScannerService
  ) {}

  private readonly config = {
    network: process.env.BLOCKCHAIN_NETWORK || 'testnet',
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL,
  };

  private async checkInvestmentTransaction(txId: string): Promise<OnchainTransactionStatus> {
    try {
      const txDetails = await this.scannerService.getTransactionDetails(txId);
      this.logger.debug(`Checking investment transaction ${txId}`, txDetails);

      if (!txDetails) {
        return OnchainTransactionStatus.NOT_FOUND;
      }

      // Check if transaction is confirmed based on block and contract validation
      if (txDetails.block && 
          txDetails.block_height && 
          txDetails.valid_contract) {
        return OnchainTransactionStatus.CONFIRMED;
      }

      // TODO: Add validation for ADA-only and correct amount
      return OnchainTransactionStatus.PENDING;
    } catch (error) {
      this.logger.error(`Failed to check investment transaction ${txId}:`, error);
      return OnchainTransactionStatus.NOT_FOUND;
    }
  }

  private async checkContributionTransaction(txId: string): Promise<OnchainTransactionStatus> {
    try {
      const txDetails = await this.scannerService.getTransactionDetails(txId);
      this.logger.debug(`Checking contribution transaction ${txId}`, txDetails);

      if (!txDetails) {
        return OnchainTransactionStatus.NOT_FOUND;
      }

      // Check if transaction is confirmed based on block and contract validation
      if (txDetails.block && 
          txDetails.block_height && 
          txDetails.valid_contract) {
        return OnchainTransactionStatus.CONFIRMED;
      }

      // TODO: Add validation for NFT assets and correct vault address
      return OnchainTransactionStatus.PENDING;
    } catch (error) {
      this.logger.error(`Failed to check contribution transaction ${txId}:`, error);
      return OnchainTransactionStatus.NOT_FOUND;
    }
  }

  async checkOnchainTransactionStatus(txHash: string, type: TransactionType): Promise<OnchainTransactionStatus> {
    try {
      switch (type) {
        case TransactionType.investment:
          return await this.checkInvestmentTransaction(txHash);
        case TransactionType.contribute:
          return await this.checkContributionTransaction(txHash);
        default:
          this.logger.warn(`Unsupported transaction type ${type} for tx ${txHash}`);
          return OnchainTransactionStatus.NOT_FOUND;
      }
    } catch (error) {
      this.logger.error(`Failed to check transaction status for hash ${txHash}:`, error);
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
        const status = await this.checkOnchainTransactionStatus(transaction.tx_hash, transaction.type);

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
