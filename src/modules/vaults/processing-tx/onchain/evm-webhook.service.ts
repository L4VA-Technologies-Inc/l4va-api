import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { EvmWebhookDto, EvmWebhookTransaction } from './dto/evm-webhook.dto';
import { WebhookTxSummaryDto } from './dto/handle-webhook.res';

import { TransactionStatus } from '@/types/transaction.types';

/**
 * Handles EVM (Robinhood) transaction webhooks delivered by Alchemy custom
 * GraphQL webhooks. Mirrors the Cardano (Blockfrost) webhook flow: verify the
 * signature, then update each local transaction and run the shared
 * post-confirmation side effects via BlockchainWebhookService.
 */
@Injectable()
export class EvmWebhookService {
  private readonly logger = new Logger(EvmWebhookService.name);
  private readonly signingKey: string;

  constructor(
    private readonly blockchainWebhookService: BlockchainWebhookService,
    private readonly configService: ConfigService
  ) {
    this.signingKey = this.configService.get<string>('ALCHEMY_WEBHOOK_SIGNING_KEY');
  }

  /**
   * Verify and process an Alchemy GraphQL webhook event.
   * The webhook's GraphQL query is expected to filter to vault-relevant
   * transactions, so unknown hashes are simply ignored.
   *
   * @param rawBody Raw request body used for signature verification
   * @param signatureHeader Value of the `x-alchemy-signature` header
   * @returns Per-transaction summary of updated local transaction ids
   */
  async handleEvmEvent(rawBody: string, signatureHeader: string): Promise<WebhookTxSummaryDto[]> {
    this.verifySignature(rawBody, signatureHeader);

    let event: EvmWebhookDto;
    try {
      event = JSON.parse(rawBody) as EvmWebhookDto;
    } catch (error) {
      this.logger.error(`Failed to parse EVM webhook body: ${error.message}`);
      throw new UnauthorizedException('Invalid webhook payload');
    }

    if (event.type !== 'GRAPHQL') {
      this.logger.debug(`Ignoring non-GRAPHQL EVM webhook type: ${event.type}`);
      return [];
    }

    const block = event?.event?.data?.block;
    const logs = block?.logs ?? [];

    // The webhook filters logs by contract address, so a single vault
    // transaction may emit several logs. Collapse them to unique transactions
    // (keyed by hash) before touching the database.
    const txByHash = new Map<string, EvmWebhookTransaction>();
    for (const log of logs) {
      const tx = log?.transaction;
      if (tx?.hash && !txByHash.has(tx.hash)) {
        txByHash.set(tx.hash, tx);
      }
    }

    this.logger.debug(
      `Processing ${txByHash.size} transaction(s) from ${logs.length} log(s) in EVM webhook ` +
        `(block ${block?.number}, network ${event?.event?.network})`
    );

    const summaries: WebhookTxSummaryDto[] = [];

    for (const tx of txByHash.values()) {
      const localTxId = await this.processTransaction(tx);
      summaries.push({
        txHash: tx.hash,
        updatedLocalTxIds: localTxId ? [localTxId] : [],
      });
    }

    return summaries;
  }

  /**
   * Update a single EVM transaction using the shared confirmation logic.
   * @returns Updated local transaction id, or null if no matching transaction
   */
  private async processTransaction(tx: EvmWebhookTransaction): Promise<string | null> {
    const internalStatus = this.determineInternalTransactionStatus(tx);
    return this.blockchainWebhookService.applyTransactionStatus(tx.hash, tx.index ?? 0, internalStatus);
  }

  /**
   * Map an EVM receipt status to an internal transaction status.
   * Webhook events only fire for mined transactions, so a receipt is present:
   * status 1 => confirmed, status 0 => failed.
   */
  private determineInternalTransactionStatus(tx: EvmWebhookTransaction): TransactionStatus {
    if (tx.status === 1) {
      return TransactionStatus.confirmed;
    }
    if (tx.status === 0) {
      return TransactionStatus.failed;
    }
    return TransactionStatus.pending;
  }

  /**
   * Verify the Alchemy webhook signature.
   * Alchemy signs the raw request body with HMAC-SHA256 using the webhook's
   * signing key and sends the hex digest in the `x-alchemy-signature` header.
   */
  private verifySignature(rawBody: string, signatureHeader: string): void {
    if (!this.signingKey) {
      this.logger.warn('ALCHEMY_WEBHOOK_SIGNING_KEY is not configured — skipping signature verification');
      return;
    }

    const digest = createHmac('sha256', this.signingKey).update(rawBody, 'utf8').digest('hex');

    const provided = Buffer.from(signatureHeader ?? '', 'utf8');
    const expected = Buffer.from(digest, 'utf8');

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      this.logger.error('Invalid Alchemy webhook signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}
