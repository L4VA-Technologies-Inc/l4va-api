import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { EvmWebhookDto, EvmWebhookTransaction } from './dto/evm-webhook.dto';
import { WebhookTxSummaryDto } from './dto/handle-webhook.res';
import { EvmVaultEventReconciler, VaultLogInput, PerTxOutcome } from './evm-vault-event-reconciler.service';

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
    private readonly configService: ConfigService,
    private readonly vaultEventReconciler: EvmVaultEventReconciler
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
      this.logger.error(`Failed to parse EVM webhook body: ${(error as Error).message}`);
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
      const txLogs = logs
        .filter(log => log?.transaction?.hash === tx.hash)
        .map(log => ({ topics: log.topics ?? [], data: log.data ?? '0x' }));

      const localTxId = await this.blockchainWebhookService.applyEvmTransactionStatus(
        tx.hash,
        tx.index ?? 0,
        this.determineInternalTransactionStatus(tx),
        txLogs
      );

      summaries.push({
        txHash: tx.hash,
        updatedLocalTxIds: localTxId ? [localTxId] : [],
      });
    }

    // ── Reconcile vault-emitted V3 events (ContributionMade,
    // ContributionCancelled, CycleClosed, CycleStatusChanged,
    // AllocationClaimed). The admin operation services are the primary
    // writers; this pass is idempotent and only closes gaps left by
    // crashes / missed receipts / third-party calls.
    const vaultLogs: VaultLogInput[] = logs
      .filter(l => Boolean(l?.account?.address) && Boolean(l?.transaction?.hash))
      .map(l => ({
        address: l.account!.address!,
        data: l.data ?? '0x',
        topics: l.topics ?? [],
        txHash: l.transaction!.hash!,
        blockNumber: block?.number ?? null,
        logIndex: l.index ?? null,
      }));
    if (vaultLogs.length > 0) {
      try {
        const stats = await this.vaultEventReconciler.reconcileLogs(vaultLogs);
        this.logger.debug(
          `Vault event reconciler: processed=${stats.processed} skipped=${stats.skipped} errors=${stats.errors}`
        );

        // Fast-path: mark each parent Transaction reconciled ONLY if its
        // per-tx outcome satisfies its expected_events spec. Anything short
        // is left for the health-check cron to retry against a fresh
        // canonical receipt. Never blindly trust webhook logs — Alchemy may
        // drop or reorder items across redeliveries.
        const distinctHashes = Array.from(new Set(vaultLogs.map(l => l.txHash)));
        for (const hash of distinctHashes) {
          await this.markTransactionReconciledIfSpecMet(hash, stats.perTx.get(hash));
        }
      } catch (err) {
        // Reconciliation failures MUST NOT roll back the tx-status updates
        // above — those are the Alchemy-mandated ack. Log and continue; the
        // TransactionHealthService cron will pick these up on its next tick.
        this.logger.error(`Vault event reconciler failed: ${(err as Error).message}`);
      }
    }

    return summaries;
  }

  /**
   * Idempotently mark an EVM transaction fully reconciled — but ONLY if its
   * expected_events spec is fully satisfied by this webhook batch. If the
   * spec is missing (legacy row) treat any errors-free outcome as ok. On
   * anything short, leave the row untouched so the durable cron retries.
   */
  private async markTransactionReconciledIfSpecMet(txHash: string, outcome?: PerTxOutcome): Promise<void> {
    try {
      const tx = await this.blockchainWebhookService.findEvmTransactionByHashOrChildHash(txHash);
      if (!tx) return;
      const verdict = this.vaultEventReconciler.verifyExpectedEvents(outcome, tx.expected_events);
      if (!verdict.ok) {
        this.logger.debug(`Webhook fast-path skip: tx ${txHash} did not satisfy expected_events (${verdict.reason})`);
        return;
      }
      if ((outcome?.errors ?? []).length > 0) return;
      // When `tx` was resolved via metadata.evmChildTxHashes, `txHash` here is
      // the child hash — but markEvmTransactionReconciled matches on the
      // parent's tx_hash column. Prefer the row's canonical hash.
      await this.blockchainWebhookService.markEvmTransactionReconciled(String(tx.tx_hash ?? txHash));
    } catch (err) {
      this.logger.debug(`markTransactionReconciledIfSpecMet(${txHash}) failed: ${(err as Error).message}`);
    }
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
