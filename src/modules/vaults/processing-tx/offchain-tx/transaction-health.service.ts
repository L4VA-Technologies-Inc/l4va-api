import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createPublicClient, http, PublicClient } from 'viem';

import { BlockchainWebhookService } from '../onchain/blockchain-webhook.service';
import { EvmVaultEventReconciler, VaultLogInput } from '../onchain/evm-vault-event-reconciler.service';

import { TransactionsService } from './transactions.service';

import { Transaction } from '@/database/transaction.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class TransactionHealthService {
  private readonly logger = new Logger(TransactionHealthService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly evmClient?: PublicClient;
  private readonly STUCK_TRANSACTION_TIMEOUT_MINUTES = 1;
  private readonly MAX_RECONCILIATION_ATTEMPTS = 12;
  private readonly RECONCILIATION_BATCH_SIZE = 50;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainWebhookService: BlockchainWebhookService,
    private readonly configService: ConfigService,
    private readonly vaultEventReconciler: EvmVaultEventReconciler
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
   * Health check cron job that runs every 5 minutes.
   *
   * Two independent sweeps:
   *   1. Stuck-submitted: transactions in 'submitted' status past the timeout;
   *      fetch receipt, update status.
   *   2. Stuck-reconciliation: confirmed EVM transactions whose domain-event
   *      reconciliation hasn't succeeded yet; retry via
   *      EvmVaultEventReconciler.reconcileLogs. This is the DURABLE RETRY
   *      PATH for the Alchemy webhook. An EVM tx is only fully processed
   *      when reconciled_at is set.
   */
  @Cron(CronExpression.EVERY_MINUTE)
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

      if (stuckTransactions.length > 0) {
        this.logger.log(`Found ${stuckTransactions.length} potentially stuck transactions, verifying on-chain...`);
        const results = await Promise.allSettled(stuckTransactions.map(tx => this.verifyAndUpdateTransaction(tx)));
        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;
        this.logger.log(`Stuck-tx sweep: ${successful} verified, ${failed} errored`);
      } else {
        this.logger.debug('No stuck transactions found');
      }
    } catch (error) {
      this.logger.error('Error during health check for stuck transactions', error);
    }

    // Second sweep — retry EVM reconciliation for confirmed txs whose
    // domain events have not been reconciled yet.
    try {
      await this.sweepEvmReconciliation();
    } catch (error) {
      this.logger.error('Error during EVM reconciliation sweep', error);
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

          // Run domain-event reconciliation immediately using the same
          // receipt we already fetched. Idempotent — safe if the webhook
          // already handled it. Reconciliation status is persisted so the
          // cron can retry on the next tick if this fails.
          await this.reconcileEvmReceipt(transaction, receipt);
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

  // ==========================================================================
  // EVM domain-event reconciliation
  // ==========================================================================

  /**
   * Cron sweep — reprocess EVM transactions whose receipt is confirmed but
   * whose domain events have not been reconciled yet. This is the durable
   * retry path complementing the Alchemy webhook.
   */
  private async sweepEvmReconciliation(): Promise<void> {
    if (!this.evmClient) return;

    const pending = await this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.status = :status', { status: TransactionStatus.confirmed })
      .andWhere('transaction.tx_hash IS NOT NULL')
      .andWhere('transaction.chain_id IS NOT NULL')
      .andWhere('transaction.reconciled_at IS NULL')
      .andWhere(`(transaction.reconciliation_status IS NULL OR transaction.reconciliation_status = :pending)`, {
        pending: EvmReconciliationStatus.pending,
      })
      .andWhere('transaction.reconciliation_attempts < :maxAttempts', {
        maxAttempts: this.MAX_RECONCILIATION_ATTEMPTS,
      })
      .orderBy('transaction.updated_at', 'ASC')
      .limit(this.RECONCILIATION_BATCH_SIZE)
      .getMany();

    if (pending.length === 0) {
      this.logger.debug('EVM reconciliation sweep: nothing to do');
      return;
    }

    this.logger.log(`EVM reconciliation sweep: ${pending.length} tx(s) pending`);
    await Promise.allSettled(pending.map(tx => this.reconcileEvmTransactionByHash(tx)));
  }

  /**
   * Fetch the receipt for a stored EVM tx and drive reconciliation.
   * Used by the sweep for retries.
   */
  private async reconcileEvmTransactionByHash(transaction: Transaction): Promise<void> {
    if (!this.evmClient) return;

    try {
      const receipt = await this.evmClient.getTransactionReceipt({
        hash: transaction.tx_hash as `0x${string}`,
      });
      if (!receipt) {
        await this.recordReconciliationAttempt(
          transaction,
          EvmReconciliationStatus.pending,
          `receipt not found for tx ${transaction.tx_hash}`
        );
        return;
      }
      if (receipt.status !== 'success') {
        // A reverted receipt is a terminal state for reconciliation — no
        // events to decode. Mark failed so the sweep stops touching it.
        await this.recordReconciliationAttempt(
          transaction,
          EvmReconciliationStatus.failed,
          `receipt.status=${receipt.status} (reverted); nothing to reconcile`
        );
        return;
      }
      await this.reconcileEvmReceipt(transaction, receipt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.recordReconciliationAttempt(transaction, EvmReconciliationStatus.pending, `fetch failed: ${msg}`);
    }
  }

  /**
   * Given a successful receipt, decode all Vault events and hand them to
   * EvmVaultEventReconciler.reconcileLogs. Persist reconciliation status,
   * attempt count and last error. Idempotent — safe to invoke repeatedly.
   *
   * A tx is considered fully processed only after this reaches 'success'.
   */
  private async reconcileEvmReceipt(
    transaction: Transaction,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receipt: any
  ): Promise<void> {
    const vaultLogs: VaultLogInput[] = (receipt.logs ?? []).map((log: any) => ({
      address: String(log.address ?? ''),
      data: String(log.data ?? '0x'),
      topics: (log.topics ?? []) as string[],
      txHash: transaction.tx_hash,
      blockNumber: receipt.blockNumber != null ? String(receipt.blockNumber) : null,
      logIndex: typeof log.logIndex === 'number' ? log.logIndex : null,
    }));

    const expected = transaction.expected_events;

    // No logs AND no expected events → truly a no-op (unrelated tx). Success.
    // No logs BUT expected events → hard failure — the receipt should have
    // included them.
    if (vaultLogs.length === 0) {
      if (expected && expected.length > 0) {
        await this.recordReconciliationAttempt(
          transaction,
          EvmReconciliationStatus.pending,
          `receipt has zero vault logs but tx expected ${expected.map(e => e.name).join(', ')}`
        );
      } else {
        await this.markReconciled(transaction);
      }
      return;
    }

    let stats: Awaited<ReturnType<EvmVaultEventReconciler['reconcileLogs']>>;
    try {
      stats = await this.vaultEventReconciler.reconcileLogs(vaultLogs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.recordReconciliationAttempt(transaction, EvmReconciliationStatus.pending, `reconciler threw: ${msg}`);
      return;
    }

    // Expected-event check — enforced regardless of aggregate error count so
    // "skipped when required" counts as a reconciliation error.
    const verdict = this.vaultEventReconciler.verifyExpectedEvents(stats.perTx.get(transaction.tx_hash), expected);
    if (!verdict.ok) {
      await this.recordReconciliationAttempt(
        transaction,
        EvmReconciliationStatus.pending,
        verdict.reason ?? 'expected-event check failed'
      );
      return;
    }

    // Aggregate reconciler errors — anything the reconciler couldn't apply.
    if (stats.errors > 0) {
      const perTx = stats.perTx.get(transaction.tx_hash);
      await this.recordReconciliationAttempt(
        transaction,
        EvmReconciliationStatus.pending,
        `reconciler errors=${stats.errors} for tx ${transaction.tx_hash}: ${(perTx?.errors ?? []).slice(0, 3).join('; ') || '(no per-tx detail)'}`
      );
      return;
    }

    await this.markReconciled(transaction);
  }

  private async markReconciled(transaction: Transaction): Promise<void> {
    await this.transactionRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        reconciliation_status: EvmReconciliationStatus.success,
        reconciled_at: new Date(),
        reconciliation_last_error: null,
      })
      .where('id = :id AND reconciled_at IS NULL', { id: transaction.id })
      .execute();
  }

  private async recordReconciliationAttempt(
    transaction: Transaction,
    status: EvmReconciliationStatus,
    lastError: string
  ): Promise<void> {
    const attempts = (transaction.reconciliation_attempts ?? 0) + 1;
    // Terminal states:
    //   - `failed` for explicitly unrecoverable outcomes (reverted receipts).
    //   - `manual_review_required` after retry cap for anything else. Retryable
    //     via the explicit `retryReconciliation(txId)` admin path.
    let finalStatus: EvmReconciliationStatus;
    if (status === EvmReconciliationStatus.failed) {
      finalStatus = EvmReconciliationStatus.failed;
    } else if (attempts >= this.MAX_RECONCILIATION_ATTEMPTS) {
      finalStatus = EvmReconciliationStatus.manual_review_required;
    } else {
      finalStatus = EvmReconciliationStatus.pending;
    }

    await this.transactionRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        reconciliation_status: finalStatus,
        reconciliation_attempts: attempts,
        reconciliation_last_error: lastError.slice(0, 500),
      })
      .where('id = :id', { id: transaction.id })
      .execute();

    if (finalStatus === EvmReconciliationStatus.failed) {
      this.logger.error(
        `EVM reconciliation FAILED terminally for tx ${transaction.tx_hash} after ${attempts} attempt(s): ${lastError}`
      );
    } else if (finalStatus === EvmReconciliationStatus.manual_review_required) {
      this.logger.error(
        `EVM reconciliation NEEDS MANUAL REVIEW for tx ${transaction.tx_hash} after ${attempts} attempt(s): ${lastError}. ` +
          `Use retryReconciliation(txId) to reset.`
      );
    } else {
      this.logger.warn(
        `EVM reconciliation attempt ${attempts}/${this.MAX_RECONCILIATION_ATTEMPTS} for tx ${transaction.tx_hash}: ${lastError}`
      );
    }
  }

  /**
   * Explicit retry path for a Transaction stuck in `manual_review_required`
   * (or `failed`). Resets attempts to zero and flips status back to
   * `pending` so the cron sweep picks it up on the next tick.
   */
  async retryReconciliation(txId: string): Promise<boolean> {
    const result = await this.transactionRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        reconciliation_status: EvmReconciliationStatus.pending,
        reconciliation_attempts: 0,
        reconciliation_last_error: null,
      })
      .where('id = :id AND reconciled_at IS NULL AND reconciliation_status IN (:...retryable)', {
        id: txId,
        retryable: [EvmReconciliationStatus.manual_review_required, EvmReconciliationStatus.failed],
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
