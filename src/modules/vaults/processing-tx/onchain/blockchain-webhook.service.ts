import { verifyWebhookSignature, SignatureVerificationError } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { BlockchainWebhookDto, BlockfrostTransaction, BlockfrostTransactionEvent } from './dto/webhook.dto';
import { OnchainTransactionStatus } from './types/transaction-status.enum';

import { TransactionStatus } from '@/types/transaction.types';

@Injectable()
export class BlockchainWebhookService {
  private readonly logger = new Logger(BlockchainWebhookService.name);
  private readonly webhookAuthToken: string;
  private readonly maxEventAge: number;
  private readonly RECEIPT_ASSET_NAME = '72656365697074'; // "receipt" in hex

  // Status mapping for blockchain events
  private readonly STATUS_MAP: Record<OnchainTransactionStatus, TransactionStatus> = {
    [OnchainTransactionStatus.PENDING]: TransactionStatus.pending,
    [OnchainTransactionStatus.CONFIRMED]: TransactionStatus.confirmed,
    [OnchainTransactionStatus.FAILED]: TransactionStatus.failed,
    [OnchainTransactionStatus.NOT_FOUND]: TransactionStatus.stuck,
  };

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService
  ) {
    this.webhookAuthToken = this.configService.get<string>('BLOCKFROST_WEBHOOK_AUTH_TOKEN');
    this.maxEventAge = 600; // 10 minutes max age for webhook events
  }

  /**
   * Handle blockchain webhook events from Blockfrost
   * Webhook is configured to trigger on transactions involving vault reference address
   * Filters for vault contributions by checking for receipt token minting
   * Verifies webhook signature using Blockfrost SDK
   */
  async handleBlockchainEvent(rawBody: string, signatureHeader: string): Promise<string[]> {
    // Verify webhook signature using Blockfrost SDK
    let event: BlockchainWebhookDto;
    try {
      const verifiedEvent = verifyWebhookSignature(
        rawBody,
        signatureHeader,
        this.webhookAuthToken,
        this.maxEventAge // Maximum allowed age of the webhook event in seconds
      );
      event = verifiedEvent as unknown as BlockchainWebhookDto;
      this.logger.log('Webhook signature verified successfully');
    } catch (error) {
      if (error instanceof SignatureVerificationError) {
        this.logger.error('Invalid webhook signature', {
          signatureHeader: error.detail?.signatureHeader,
          error: error.message,
        });
        throw new UnauthorizedException('Invalid webhook signature');
      }
      this.logger.error('Error verifying webhook signature', error);
      throw error;
    }

    if (event.type !== 'transaction') {
      this.logger.debug(`Ignoring non-transaction event type: ${event.type}`);
      return [];
    }

    this.logger.debug(`Processing ${event.payload.length} transaction(s) from blockchain webhook`);

    const updatedLocalTxIds: string[] = [];

    for (const txEvent of event.payload) {
      const localTxId = await this.processTransaction(txEvent);
      if (localTxId) {
        updatedLocalTxIds.push(localTxId);
      }
    }

    return updatedLocalTxIds;
  }

  /**
   * Process individual transaction from webhook
   */
  private async processTransaction({ tx }: BlockfrostTransactionEvent): Promise<string> {
    try {
      const internalStatus = this.determineInternalTransactionStatus(tx);
      const transaction = await this.transactionsService.updateTransactionStatusAndLockAssets(
        tx.hash,
        tx.index,
        internalStatus
      );

      if (!transaction) {
        return null;
      }

      this.logger.log(`WH: Transaction ${tx.hash} status updated to ${internalStatus}`);
      return transaction.id;
    } catch (error) {
      this.logger.error(`WH: Failed to process transaction ${tx.hash}: ${error.message}`, error.stack);
      return null;
    }
  }

  private determineInternalTransactionStatus(tx: BlockfrostTransaction): TransactionStatus {
    if (!tx.block || !tx.block_height) {
      return this.STATUS_MAP[OnchainTransactionStatus.PENDING];
    } else if (tx.valid_contract === false) {
      return this.STATUS_MAP[OnchainTransactionStatus.FAILED];
    } else if (tx.valid_contract === true) {
      return this.STATUS_MAP[OnchainTransactionStatus.CONFIRMED];
    }
    return this.STATUS_MAP[OnchainTransactionStatus.PENDING];
  }
}
