import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TransactionsService } from '../offchain-tx/transactions.service';

import {
  BlockchainWebhookDto,
  BlockfrostTransaction,
  BlockfrostTransactionEvent,
  BlockfrostTxOutput,
} from './dto/webhook.dto';
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

  verifySignature(payload: string, signatureHeader: string): boolean {
    if (!this.webhookAuthToken) {
      this.logger.error('BLOCKFROST_WEBHOOK_AUTH_TOKEN is not configured');
      throw new Error('BLOCKFROST_WEBHOOK_AUTH_TOKEN is not configured');
    }

    if (!signatureHeader) {
      this.logger.error('blockfrost-signature header is missing');
      throw new Error('blockfrost-signature header is missing');
    }

    try {
      // Parse the signature header
      const [timestampHeader, signatureValue] = signatureHeader.split(',');
      const timestamp = timestampHeader.split('=')[1];
      const signature = signatureValue.split('=')[1];

      // Log parsed values
      this.logger.debug('Parsed signature components:', {
        timestamp,
        signature,
        payloadLength: payload.length,
      });

      // Prepare the signature payload as per Blockfrost docs
      const signaturePayload = `${timestamp}.${payload}`;

      // Compute HMAC
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookAuthToken)
        .update(signaturePayload)
        .digest('hex');

      // Log computed values for debugging
      this.logger.debug('Computed signature:', {
        expectedSignature,
        receivedSignature: signature,
        match: expectedSignature === signature,
      });

      // Verify timestamp is within tolerance
      const currentTime = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(currentTime - parseInt(timestamp));

      if (timeDiff > this.maxEventAge) {
        this.logger.error('Webhook event is too old:', {
          eventTime: timestamp,
          currentTime,
          maxAge: this.maxEventAge,
        });
        return false;
      }

      // Compare signatures
      if (expectedSignature === signature) {
        this.logger.log('Webhook signature verified successfully');
        return true;
      }

      this.logger.error('Signature mismatch:', {
        expected: expectedSignature,
        received: signature,
      });
      return false;
    } catch (error) {
      this.logger.error('Error during signature verification:', {
        error: error.message,
        signatureHeader,
      });
      return false;
    }
  }

  /**
   * Handle blockchain webhook events from Blockfrost
   * Verifies signature and processes transactions
   * Webhook is configured to trigger on transactions involving vault reference address
   * Filters for vault contributions by checking for receipt token minting
   */
  async handleBlockchainEvent(event: BlockchainWebhookDto): Promise<void> {
    if (event.type !== 'transaction') {
      this.logger.debug(`Ignoring non-transaction event type: ${event.type}`);
      return;
    }

    this.logger.debug(`Processing ${event.payload.length} transaction(s) from blockchain webhook`);

    for (const txEvent of event.payload) {
      await this.processTransaction(txEvent);
    }
  }

  /**
   * Process individual transaction from webhook
   */
  private async processTransaction(txEvent: BlockfrostTransactionEvent): Promise<void> {
    const { tx, outputs } = txEvent;

    // Check if this is a vault-related transaction (has receipt token)
    const isVaultTransaction = this.isVaultTransaction(tx, outputs);

    if (!isVaultTransaction) {
      this.logger.debug(`Transaction ${tx.hash} doesn't involve receipt token, skipping`);
      return;
    }

    this.logger.debug(`Processing vault transaction ${tx.hash}`);

    try {
      const internalStatus = this.determineInternalTransactionStatus(tx);
      await this.transactionsService.updateTransactionStatus(tx.hash, tx.index, internalStatus);
      this.logger.debug(`TEST: Transaction ${tx.hash} status could be updated to ${internalStatus}`);
    } catch (error) {
      this.logger.error(`Failed to process transaction ${tx.hash}: ${error.message}`, error.stack);
    }
  }

  /**
   * Check if transaction is a vault transaction (contribution or extraction)
   * Identifies by checking if receipt token was minted
   * Note: Webhook already filters for transactions involving vault reference address
   */
  private isVaultTransaction(tx: BlockfrostTransaction, outputs: BlockfrostTxOutput[]): boolean {
    // Only process transactions that minted/burned assets
    if (tx.asset_mint_or_burn_count === 0) {
      return false;
    }

    // Check if any output contains a receipt token
    // Receipt tokens always end with "receipt" in hex (72656365697074)
    for (const output of outputs) {
      for (const asset of output.amount) {
        if (asset.unit !== 'lovelace' && asset.unit.endsWith(this.RECEIPT_ASSET_NAME)) {
          this.logger.debug(`Found receipt token in tx ${tx.hash}: ${asset.unit}`);
          return true;
        }
      }
    }

    return false;
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
