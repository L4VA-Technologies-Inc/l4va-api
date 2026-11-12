import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { decodeEventLog, type Address, type Hex } from 'viem';

import { TransactionsService } from '../offchain-tx/transactions.service';

import { EvmContractReader } from './evm-contract-reader.service';
import { deriveContributionNonce } from './evm-contribution-nonce';
import { EvmCycleCloseService } from './evm-cycle-close.service';
import { lpTechnicalCycleRoot } from './evm-lp.config';
import { EvmAssetKindOnchain, EvmCycleStatus, VAULT_ABI } from './vault.abi';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { EvmExternalPosition, EvmPositionStatus } from '@/database/evm-external-position.entity';
import { EvmIndexRebalance } from '@/database/evm-index-rebalance.entity';
import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { RewardEventProducer } from '@/modules/rewards/services/reward-event-producer.service';
import { AssetStatus, AssetType } from '@/types/asset.types';
import { EvmDistributionClaimMetadata } from '@/types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { IndexLegStatus, IndexRebalanceStatus } from '@/types/index-vault.types';
import { RewardActivityType } from '@/types/rewards.types';
import { ExpectedEventSpec, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

/** How long a contribution may wait for the app's /confirm before the reconciler binds it itself. */
const ADOPTION_GRACE_SECONDS = 15 * 60;

export interface VaultLogInput {
  address: string;
  data: string;
  topics: string[];
  txHash: string;
  blockNumber?: number | string | bigint | null;
  logIndex?: number | null;
}

export interface ReconcileStats {
  processed: number;
  skipped: number;
  errors: number;
  /**
   * Per-tx-hash outcome. Callers use this + `expected_events` on their
   * Transaction row to decide whether the tx counts as reconciled.
   */
  perTx: Map<string, PerTxOutcome>;
}

export interface PerTxOutcome {
  /** Event name → total occurrences successfully applied to the DB. */
  applied: Map<string, number>;
  /** Human-readable errors observed while decoding/applying logs for this tx. */
  errors: string[];
}

export interface ExpectedEventVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Reconciler for the five V3 vault events. Idempotent by design — the admin
 * operation services are the primary writers, this is the reconciliation path.
 *
 * `reconcileLogs()` returns per-tx-hash outcomes; callers combine them with
 * the Transaction's `expected_events` spec to decide whether the whole tx
 * has been fully reconciled.
 */
@Injectable()
export class EvmVaultEventReconciler {
  private readonly logger = new Logger(EvmVaultEventReconciler.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmContribution) private readonly contribsRepository: Repository<EvmContribution>,
    @InjectRepository(EvmAllocation) private readonly allocationsRepository: Repository<EvmAllocation>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    @InjectRepository(Asset) private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(EvmExternalPosition) private readonly positionsRepository: Repository<EvmExternalPosition>,
    @InjectRepository(EvmIndexRebalance) private readonly rebalancesRepository: Repository<EvmIndexRebalance>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly cycleCloseService: EvmCycleCloseService,
    private readonly transactionsService: TransactionsService,
    private readonly alerts: AlertsService,
    private readonly rewardEventProducer: RewardEventProducer
  ) {}

  /** Process a batch of vault-emitted logs. Unknown events are ignored. */
  async reconcileLogs(logs: VaultLogInput[]): Promise<ReconcileStats> {
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const perTx = new Map<string, PerTxOutcome>();

    const outcome = (hash: string): PerTxOutcome => {
      let e = perTx.get(hash);
      if (!e) {
        e = { applied: new Map(), errors: [] };
        perTx.set(hash, e);
      }
      return e;
    };
    const recordApplied = (hash: string, event: string): void => {
      const e = outcome(hash);
      e.applied.set(event, (e.applied.get(event) ?? 0) + 1);
    };
    const recordError = (hash: string, msg: string): void => {
      outcome(hash).errors.push(msg);
    };

    // Pre-resolve vault records by contract address in one query.
    const distinctAddresses = Array.from(new Set(logs.map(l => l.address.toLowerCase())));
    const vaults = distinctAddresses.length
      ? await this.vaultsRepository
          .createQueryBuilder('v')
          .where('LOWER(v.contract_address) IN (:...addrs)', { addrs: distinctAddresses })
          .getMany()
      : [];
    const vaultByAddress = new Map<string, Vault>();
    for (const v of vaults) if (v.contract_address) vaultByAddress.set(v.contract_address.toLowerCase(), v);

    for (const log of logs) {
      try {
        const vault = vaultByAddress.get(log.address.toLowerCase());
        if (!vault) {
          skipped++;
          continue;
        }
        const decoded = this.tryDecode(log);
        if (!decoded) {
          skipped++;
          continue;
        }

        switch (decoded.eventName) {
          case 'ContributionMade':
            await this.handleContributionMade(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'ContributionCancelled':
            await this.handleContributionCancelled(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'CycleClosed':
            await this.handleCycleClosed(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'CycleStatusChanged':
            await this.handleCycleStatusChanged(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'AllocationClaimed':
            await this.handleAllocationClaimed(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'PositionOpened':
            await this.handlePositionOpened(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'PositionClosed':
            await this.handlePositionClosed(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'Swapped':
            await this.handleSwapped(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'DistributionClaimed':
            await this.handleDistributionClaimed(vault, log, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          case 'TerminationCommitted':
          case 'Redeemed':
          case 'RedemptionDeferred':
          case 'DeferredClaimed':
          case 'TerminationAssetDeferred':
          case 'TerminationAssetResumed':
          case 'TerminationRemainderSwept':
            await this.handleTerminationEvent(vault, log, decoded.eventName, decoded.args);
            recordApplied(log.txHash, decoded.eventName);
            processed++;
            break;
          default:
            skipped++;
        }
      } catch (err) {
        errors++;
        const msg = (err as Error).message;
        this.logger.error(`Failed to reconcile log (tx=${log.txHash}, addr=${log.address}): ${msg}`);
        void this.alerts.sendAlert('evm_event_reconcile_failed', {
          chain: 'robinhood',
          txHash: log.txHash,
          address: log.address,
          error: msg,
        });
        recordError(log.txHash, msg);
      }
    }

    return { processed, skipped, errors, perTx };
  }

  /**
   * Verify a per-tx outcome against the caller's expected_events spec. Every
   * expected `(name, count)` must be met exactly (or exceeded — same event
   * emitted more times than declared is a defensive-OK). Missing / short
   * counts are failures. Empty spec = always ok.
   */
  verifyExpectedEvents(
    outcome: PerTxOutcome | undefined,
    expected: ExpectedEventSpec[] | null | undefined
  ): ExpectedEventVerdict {
    if (!expected || expected.length === 0) return { ok: true };

    if (!outcome) {
      return {
        ok: false,
        reason: `no vault events decoded but expected ${expected.map(e => `${e.name}${e.count && e.count > 1 ? `x${e.count}` : ''}`).join(', ')}`,
      };
    }
    if (outcome.errors.length > 0) {
      return { ok: false, reason: `reconciler errors: ${outcome.errors.slice(0, 3).join('; ')}` };
    }

    const shortfalls: string[] = [];
    for (const spec of expected) {
      const required = spec.count ?? 1;
      const got = outcome.applied.get(spec.name) ?? 0;
      if (got < required) shortfalls.push(`${spec.name}: got ${got}, expected ${required}`);
    }
    if (shortfalls.length > 0) {
      return { ok: false, reason: `expected-event shortfall: ${shortfalls.join('; ')}` };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Per-event handlers
  // -------------------------------------------------------------------------

  /**
   * ContributionMade(contributionId, cycleId, contributor, kind, asset, tokenId, amount)
   *
   * The parent DB Transaction may be bound to either:
   *   (a) the top-level user tx hash (`transactions.tx_hash`), OR
   *   (b) any of the child hashes stored in `metadata.evmChildTxHashes` when
   *       the user submitted approvals + N contribute() calls under one
   *       Transaction row.
   */
  private async handleContributionMade(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const contributionId = String(args.contributionId as bigint);
    const cycleId = String(args.cycleId as bigint);
    const contributor = String(args.contributor as Address).toLowerCase();
    const kind = Number(args.kind);
    const asset = String(args.asset as Address).toLowerCase();
    const tokenId = String(args.tokenId as bigint);
    const amount = String(args.amount as bigint);

    // Already reconciled? Idempotent no-op with drift check.
    const existing = await this.contribsRepository.findOne({
      where: { vault_id: vault.id, on_chain_contribution_id: contributionId },
    });
    if (existing) {
      const drift = this.diffFields({ contributor, kind, asset, tokenId, amount, cycleId }, existing);
      if (drift.length > 0) {
        throw new Error(`ContributionMade drift on existing row ${existing.id} tx=${log.txHash}: ${drift.join('; ')}`);
      }
      // A redelivery re-applies the status and the lock in case they failed the first time. The
      // reward is not re-sent: rows indexed before this code was deployed carry it under the old
      // per-transaction key, so a second one would pay twice.
      const parent = await this.transactionsRepository.findOne({
        where: { id: existing.transaction_id },
        relations: ['user'],
      });
      if (parent) {
        await this.applyContributionLanded(
          vault,
          parent,
          existing.asset_id ?? null,
          kind,
          amount,
          log,
          contributionId,
          {
            reward: false,
          }
        );
      }
      return;
    }

    // The hash a Transaction is found by is whatever the user sent to /confirm, so it only
    // suggests the parent. The authorization nonce signed into the contribution is what names it:
    // deriveContributionNonce(txId, index).
    const authNonce = await this.authNonceOf(vault, BigInt(contributionId));
    let transaction = await this.findParentTransactionForContribution(vault.id, log.txHash);
    if (transaction && !(await this.transactionIssuedNonce(transaction, authNonce))) {
      this.logger.warn(
        `ContributionMade tx=${log.txHash} contributionId=${contributionId}: transaction ${transaction.id} holds ` +
          `this hash but did not sign the contribution; resolving by nonce`
      );
      transaction = await this.adoptContributionByNonce(vault, log, authNonce, contributor);
    } else if (!transaction) {
      // Give the app's own /confirm time to land first; the contribution backfill sweep retries.
      if (!(await this.isOlderThan(log, ADOPTION_GRACE_SECONDS))) return;
      transaction = await this.adoptContributionByNonce(vault, log, authNonce, contributor);
    }
    if (!transaction) {
      // Every contribution needs our signature, so this is a signature whose
      // Transaction row is gone. Left unindexed, it blocks the cycle close.
      throw new Error(
        `ContributionMade tx=${log.txHash} contributionId=${contributionId}: no Transaction issued its authorization`
      );
    }

    const userAddr = transaction.user?.address?.toLowerCase();
    if (!userAddr) {
      throw new Error(`ContributionMade tx=${log.txHash}: transaction ${transaction.id} has no user.address`);
    }
    if (userAddr !== contributor) {
      throw new Error(
        `ContributionMade tx=${log.txHash} contributor mismatch: event=${contributor}, tx.user=${userAddr}`
      );
    }

    const rawMeta = transaction.metadata as unknown;
    const metaAssets: Array<Record<string, unknown>> = Array.isArray(rawMeta)
      ? (rawMeta as Array<Record<string, unknown>>)
      : Array.isArray((rawMeta as { assets?: unknown[] })?.assets)
        ? (rawMeta as { assets: Array<Record<string, unknown>> }).assets
        : [];
    const matchingAsset = metaAssets.find(a => this.assetMatches(a, kind, asset, tokenId, amount));
    if (!matchingAsset && metaAssets.length > 0) {
      throw new Error(
        `ContributionMade tx=${log.txHash} contributionId=${contributionId}: no matching asset in ` +
          `Transaction.metadata (kind=${kind}, asset=${asset}, tokenId=${tokenId}, amount=${amount})`
      );
    }

    const assetRow = await this.findAssetRowForContribution(transaction.id, kind, asset, tokenId);

    try {
      await this.contribsRepository.insert({
        vault_id: vault.id,
        cycle_id: cycleId,
        on_chain_contribution_id: contributionId,
        contribution_tx_hash: log.txHash,
        log_index: log.logIndex ?? null,
        block_number: log.blockNumber != null ? String(log.blockNumber) : undefined,
        contributor,
        kind,
        asset,
        token_id: tokenId,
        amount,
        status: EvmContributionRowStatus.active,
        transaction_id: transaction.id,
        asset_id: assetRow?.id ?? null,
      });
      this.logger.debug(
        `ContributionMade reconciled: contributionId=${contributionId} vault=${vault.id} contributor=${contributor}`
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Race: another handler committed first. Re-fetch and validate.
        const raceWinner = await this.contribsRepository.findOne({
          where: { vault_id: vault.id, on_chain_contribution_id: contributionId },
        });
        if (!raceWinner) {
          // Should not happen; unique conflict without a matching row.
          throw new Error(`ContributionMade 23505 but no row found for contributionId=${contributionId}`);
        }
        const drift = this.diffFields({ contributor, kind, asset, tokenId, amount, cycleId }, raceWinner);
        if (drift.length > 0) {
          throw new Error(`ContributionMade race-winner drift on ${raceWinner.id}: ${drift.join('; ')}`);
        }
        // Race-winner is consistent — treat as idempotent success.
        return;
      }
      throw err;
    }

    await this.applyContributionLanded(vault, transaction, assetRow?.id ?? null, kind, amount, log, contributionId);
  }

  /**
   * A contribution signed for `transaction` is on-chain: mark the transaction confirmed, lock the
   * Asset row of that contribution and record the reward. This is the only place an EVM
   * contribute / acquire becomes confirmed (BlockchainWebhookService.applyEvmTransactionStatus
   * leaves it to us). Idempotent: the status update is conditional, only PENDING rows lock and the
   * reward has an idempotency key.
   */
  private async applyContributionLanded(
    vault: Vault,
    transaction: Transaction,
    assetRowId: string | null,
    kind: number,
    amount: string,
    log: VaultLogInput,
    contributionId: string,
    opts: { reward: boolean } = { reward: true }
  ): Promise<void> {
    await this.transactionsRepository.update(
      {
        id: transaction.id,
        status: In([
          TransactionStatus.created,
          TransactionStatus.pending,
          TransactionStatus.submitted,
          TransactionStatus.failed,
          TransactionStatus.stuck,
        ]),
      },
      { status: TransactionStatus.confirmed }
    );

    try {
      if (assetRowId) await this.transactionsService.lockAssetsForTransaction(transaction.id, [assetRowId]);
    } catch (err) {
      // Vault value refresh (prices) can fail; the row is retried on the next redelivery / sweep.
      this.logger.warn(`Lock asset ${assetRowId} of transaction ${transaction.id} failed: ${(err as Error).message}`);
    }

    const wallet = transaction.user?.address;
    if (!opts.reward || !wallet) return;
    const isAcquire = transaction.type === TransactionType.acquire;
    const inExpansion = isAcquire
      ? vault.vault_status === VaultStatus.acquire_expansion || !!transaction.is_expansion
      : vault.vault_status === VaultStatus.expansion;
    const eventType = isAcquire
      ? inExpansion
        ? RewardActivityType.EXPANSION_TOKEN_PURCHASE
        : RewardActivityType.TOKEN_ACQUIRE
      : inExpansion
        ? RewardActivityType.EXPANSION_ASSET_CONTRIBUTION
        : RewardActivityType.ASSET_CONTRIBUTION;
    await this.rewardEventProducer.indexEvent({
      walletAddress: wallet,
      vaultId: vault.id,
      eventType,
      txHash: log.txHash,
      // One unit per contributed asset entry; an acquire counts its ETH in wei, as before.
      units: isAcquire ? Number(amount) : 1,
      metadata: {
        transaction_id: transaction.id,
        contribution_id: contributionId,
        kind,
        ...(isAcquire ? { amount } : {}),
      },
      idempotencyKey: `${eventType}:${log.txHash}:${contributionId}`,
    });
  }

  /**
   * The Asset row a landed contribution belongs to: same transaction and asset contract (any row
   * of type ETH for a native contribution), not yet bound to another contribution, preferring the
   * NFT with this token id.
   */
  private async findAssetRowForContribution(
    transactionId: string,
    kind: number,
    asset: string,
    tokenId: string
  ): Promise<Asset | null> {
    const rows = await this.assetsRepository.find({
      where: { transaction: { id: transactionId }, deleted: false },
    });
    const bound = new Set(
      (
        await this.contribsRepository.find({
          where: { transaction_id: transactionId },
          select: ['id', 'asset_id'],
        })
      )
        .map(c => c.asset_id)
        .filter((id): id is string => !!id)
    );
    const candidates = rows.filter(r => {
      if (bound.has(r.id)) return false;
      if (kind === EvmAssetKindOnchain.Native) return r.type === AssetType.ETH;
      return (r.policy_id || '').toLowerCase() === asset;
    });
    if (kind === EvmAssetKindOnchain.ERC721 || kind === EvmAssetKindOnchain.ERC1155) {
      const exact = candidates.find(r => String(r.asset_id) === tokenId);
      if (exact) return exact;
    }
    return candidates[0] ?? null;
  }

  /**
   * ContributionCancelled(contributionId, contributor)
   */
  private async handleContributionCancelled(
    vault: Vault,
    log: VaultLogInput,
    args: Record<string, unknown>
  ): Promise<void> {
    const contributionId = String(args.contributionId as bigint);
    const contributor = String(args.contributor as Address).toLowerCase();

    const row = await this.contribsRepository.findOne({
      where: { vault_id: vault.id, on_chain_contribution_id: contributionId },
    });
    if (!row) {
      throw new Error(
        `ContributionCancelled tx=${log.txHash} contributionId=${contributionId}: ` +
          `no EvmContribution row for vault ${vault.id}`
      );
    }
    if (row.status === EvmContributionRowStatus.refunded) return; // idempotent

    if (row.contributor.toLowerCase() !== contributor) {
      throw new Error(
        `ContributionCancelled tx=${log.txHash} contributor mismatch: ` + `event=${contributor}, DB=${row.contributor}`
      );
    }

    await this.dataSource.transaction(async manager => {
      const gate = await manager
        .createQueryBuilder()
        .update(EvmContribution)
        .set({
          status: EvmContributionRowStatus.refunded,
          refund_tx_hash: log.txHash,
          refunded_at: new Date(),
        })
        .where('id = :id AND status = :expected', {
          id: row.id,
          expected: EvmContributionRowStatus.active,
        })
        .execute();
      if ((gate.affected ?? 0) === 0) return; // raced

      if (row.asset_id) {
        await manager.update(
          Asset,
          { id: row.asset_id },
          { status: AssetStatus.RELEASED, released_at: new Date(), updated_at: new Date() }
        );
      }

      const remainingActive = await manager.count(EvmContribution, {
        where: { transaction_id: row.transaction_id, status: EvmContributionRowStatus.active },
      });
      if (remainingActive === 0) {
        await manager.update(
          Transaction,
          { id: row.transaction_id },
          {
            status: TransactionStatus.refunded,
            refund_tx_hash: log.txHash,
            refunded_at: new Date(),
          }
        );
      }
    });

    this.logger.log(
      `ContributionCancelled reconciled: contributionId=${contributionId} vault=${vault.id} ` +
        `contributor=${contributor} tx=${log.txHash}`
    );
  }

  /**
   * CycleClosed(cycleId, allocationRoot, valuationHash, totalVt, totalNative)
   *
   * Complete mirror of the on-chain commit into the local snapshot row.
   * Every field must match exactly; any mismatch → reconciliation_required.
   */
  private async handleCycleClosed(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const cycleId = String(args.cycleId as bigint);
    const allocationRoot = String(args.allocationRoot as Hex).toLowerCase();
    const valuationHash = String(args.valuationHash as Hex).toLowerCase();
    const totalVt = String(args.totalVtAllocation as bigint);
    const totalNative = String(args.totalNativeAllocation as bigint);

    const snapshot = await this.snapshotsRepository.findOne({
      where: { vault_id: vault.id, cycle_id: cycleId },
    });
    if (!snapshot) {
      // The empty technical cycle EvmLiquidityService opens to seed LP has no snapshot by design.
      if (
        totalVt === '0' &&
        totalNative === '0' &&
        vault.contract_address &&
        allocationRoot === lpTechnicalCycleRoot(vault.contract_address as Address, BigInt(cycleId)).toLowerCase()
      ) {
        return;
      }
      throw new Error(
        `CycleClosed for vault ${vault.id} cycle ${cycleId} tx=${log.txHash} has NO local snapshot. ` +
          `Root=${allocationRoot} committed without our involvement.`
      );
    }
    if (snapshot.status === EvmSnapshotStatus.confirmed) return; // idempotent

    const rootMatch = (snapshot.merkle_root ?? '').toLowerCase() === allocationRoot;
    const hashMatch = (snapshot.valuation_hash ?? '').toLowerCase() === valuationHash;
    const vtMatch = snapshot.total_vt_allocation === totalVt;
    const nativeMatch = snapshot.total_native_allocation === totalNative;

    if (rootMatch && hashMatch && vtMatch && nativeMatch) {
      await this.dataSource.transaction(async manager => {
        await manager.update(
          EvmValuationSnapshot,
          { id: snapshot.id },
          {
            status: EvmSnapshotStatus.confirmed,
            submit_tx_hash: snapshot.submit_tx_hash ?? log.txHash,
            confirmed_at: snapshot.confirmed_at ?? new Date(),
            failure_reason: null,
          }
        );
        await manager
          .createQueryBuilder()
          .update(Vault)
          .set({
            // Same transition as EvmCycleCloseService.commitConfirmed: a closed cycle locks the vault.
            // Without it a close recovered from the event (lost receipt) left the vault in acquire.
            vault_status: VaultStatus.locked,
            locked_at: new Date(),
            evm_current_cycle_id: cycleId,
            evm_allocation_root: allocationRoot,
            evm_close_cycle_tx_hash: snapshot.submit_tx_hash ?? log.txHash,
            evm_root_committed_at: () => 'COALESCE("evm_root_committed_at", CURRENT_TIMESTAMP)',
          })
          .where('id = :id AND evm_root_committed_at IS NULL', { id: vault.id })
          .execute();
      });
      this.logger.log(`CycleClosed reconciled → confirmed: snapshot=${snapshot.id} cycle=${cycleId}`);
      return;
    }

    const diffs: string[] = [];
    if (!rootMatch) diffs.push(`root ${allocationRoot} vs ${snapshot.merkle_root}`);
    if (!hashMatch) diffs.push(`valuationHash ${valuationHash} vs ${snapshot.valuation_hash}`);
    if (!vtMatch) diffs.push(`totalVt ${totalVt} vs ${snapshot.total_vt_allocation}`);
    if (!nativeMatch) diffs.push(`totalNative ${totalNative} vs ${snapshot.total_native_allocation}`);

    if (snapshot.status !== EvmSnapshotStatus.reconciliation_required) {
      await this.snapshotsRepository.update(
        { id: snapshot.id },
        {
          status: EvmSnapshotStatus.reconciliation_required,
          failure_reason: `CycleClosed webhook mismatch: ${diffs.join('; ')}`,
        }
      );
    }
    throw new Error(`CycleClosed MISMATCH vault=${vault.id} cycle=${cycleId} tx=${log.txHash}: ${diffs.join('; ')}`);
  }

  /**
   * CycleStatusChanged(cycleId, previous, next)
   */
  private async handleCycleStatusChanged(
    vault: Vault,
    log: VaultLogInput,
    args: Record<string, unknown>
  ): Promise<void> {
    const cycleId = String(args.cycleId as bigint);
    const nextStatus = Number(args.next);
    if (nextStatus !== EvmCycleStatus.Cancelled) return;
    if (vault.evm_cancel_cycle_tx_hash) return; // idempotent
    // The column tracks the current cycle only. A replayed cancel of an earlier cycle (multi-cycle vault)
    // must not flag the vault — the refund pipeline reads per-cycle status on-chain.
    if (vault.evm_current_cycle_id && vault.evm_current_cycle_id !== cycleId) return;
    const res = await this.vaultsRepository
      .createQueryBuilder()
      .update(Vault)
      .set({ evm_cancel_cycle_tx_hash: log.txHash })
      .where('id = :id AND evm_cancel_cycle_tx_hash IS NULL', { id: vault.id })
      .andWhere('(evm_current_cycle_id IS NULL OR evm_current_cycle_id = :cycleId)', { cycleId })
      .execute();
    if (!res.affected) return;
    this.logger.warn(
      `CycleStatusChanged(Cancelled) vault=${vault.id} cycle=${cycleId} tx=${log.txHash} recorded via reconciler`
    );
  }

  /**
   * AllocationClaimed(cycleId, claimIndex, contributor, vtAmount, nativeAmount)
   * Persists tx hash + block number on the leaf row.
   */
  private async handleAllocationClaimed(
    vault: Vault,
    log: VaultLogInput,
    args: Record<string, unknown>
  ): Promise<void> {
    const cycleId = String(args.cycleId as bigint);
    const claimIndex = String(args.claimIndex as bigint);
    const contributor = String(args.contributor as Address).toLowerCase();
    const vtAmount = String(args.vtAmount as bigint);
    const nativeAmount = String(args.nativeAmount as bigint);

    const row = await this.allocationsRepository.findOne({
      where: { vault_id: vault.id, cycle_id: cycleId, claim_index: claimIndex },
    });
    if (!row) {
      throw new Error(
        `AllocationClaimed vault=${vault.id} cycle=${cycleId} claimIndex=${claimIndex} tx=${log.txHash}: no allocation row`
      );
    }
    if (row.claimed_at) return; // idempotent
    if (
      row.contributor.toLowerCase() !== contributor ||
      row.vt_amount !== vtAmount ||
      row.native_amount !== nativeAmount
    ) {
      throw new Error(
        `AllocationClaimed MISMATCH row=${row.id} tx=${log.txHash}: ` +
          `contributor(event=${contributor}, DB=${row.contributor}) ` +
          `vt(event=${vtAmount}, DB=${row.vt_amount}) native(event=${nativeAmount}, DB=${row.native_amount})`
      );
    }

    await this.allocationsRepository
      .createQueryBuilder()
      .update(EvmAllocation)
      .set({
        claimed_at: new Date(),
        claim_tx_hash: log.txHash,
        claim_block_number: log.blockNumber != null ? String(log.blockNumber) : null,
      })
      .where('id = :id AND claimed_at IS NULL', { id: row.id })
      .execute();

    this.logger.log(
      `AllocationClaimed reconciled: vault=${vault.id} cycle=${cycleId} claimIndex=${claimIndex} tx=${log.txHash}`
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Find the parent DB Transaction for a ContributionMade event. Two paths:
   *   1. `transactions.tx_hash = log.txHash` — the classic single-broadcast case.
   *   2. Any Transaction whose `metadata.evmChildTxHashes` array contains
   *      `log.txHash` — for the user contribution flow where the frontend
   *      submits N approvals + N contributeXxx() calls under ONE Transaction.
   *
   * `metadata.evmChildTxHashes` is written by the frontend when it confirms a
   * contribution (see useEvmContributeTransaction.js).
   */
  private async findParentTransactionForContribution(vaultId: string, txHash: string): Promise<Transaction | null> {
    const direct = await this.transactionsRepository.findOne({
      where: { tx_hash: txHash, vault_id: vaultId },
      relations: ['user'],
    });
    if (direct) return direct;

    // Fallback: JSONB `@>` containment. Wraps the tx hash in a JSON array so
    // Postgres will find it inside `metadata.evmChildTxHashes: [...]`.
    return this.transactionsRepository
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'user')
      .where('t.vault_id = :vaultId', { vaultId })
      .andWhere(`t.metadata -> 'evmChildTxHashes' @> :hashArray::jsonb`, {
        hashArray: JSON.stringify([txHash]),
      })
      .getOne();
  }

  /**
   * Parent lookup for a contribution submitted outside our confirm flow: the
   * user took the signed authorization from prepare and sent it from another
   * frontend, a script, or closed the tab before /confirm. The on-chain
   * `authNonce` is `deriveContributionNonce(txId, index)`, which names the
   * Transaction exactly. The tx hash is then bound to it the way /confirm
   * would, so the health cron confirms it and its Asset rows exist.
   */
  private async adoptContributionByNonce(
    vault: Vault,
    log: VaultLogInput,
    authNonce: bigint | null,
    contributor: string
  ): Promise<Transaction | null> {
    if (authNonce === null) return null;

    const candidates = await this.transactionsRepository
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.user', 'user')
      .where('t.vault_id = :vaultId', { vaultId: vault.id })
      .andWhere('t.type IN (:...types)', { types: [TransactionType.contribute, TransactionType.acquire] })
      .andWhere('LOWER(user.address) = :contributor', { contributor })
      .getMany();

    for (const candidate of candidates) {
      const slots = await this.nonceSlots(candidate);
      for (let i = 0; i < slots.count; i++) {
        if (deriveContributionNonce(candidate.id, i) === authNonce) {
          await this.bindContributionHash(candidate, log.txHash, slots.metaAssets > 0 && slots.assetRows === 0);
          return candidate;
        }
      }
    }
    return null;
  }

  /** `authNonce` of on-chain contribution `contributionId`, or null when the vault has no address. */
  private async authNonceOf(vault: Vault, contributionId: bigint): Promise<bigint | null> {
    if (!vault.contract_address) return null;
    const onchain = await this.contractReader.getContribution(vault.contract_address as Address, contributionId);
    return BigInt(onchain.authNonce);
  }

  /** Whether one of `transaction`'s signed authorizations carries `authNonce`. */
  private async transactionIssuedNonce(transaction: Transaction, authNonce: bigint | null): Promise<boolean> {
    if (authNonce === null) return false;
    const slots = await this.nonceSlots(transaction);
    for (let i = 0; i < slots.count; i++) {
      if (deriveContributionNonce(transaction.id, i) === authNonce) return true;
    }
    return false;
  }

  /** Asset indexes a Transaction can have signed: its metadata assets, or its Asset rows once metadata is consumed. */
  private async nonceSlots(
    transaction: Transaction
  ): Promise<{ count: number; metaAssets: number; assetRows: number }> {
    const meta = transaction.metadata as unknown;
    const metaAssets = (Array.isArray(meta) ? meta : ((meta as { assets?: unknown[] })?.assets ?? [])).length;
    const assetRows = await this.assetsRepository.count({
      where: { transaction: { id: transaction.id } },
    });
    return { count: Math.max(metaAssets, assetRows), metaAssets, assetRows };
  }

  private async isOlderThan(log: VaultLogInput, seconds: number): Promise<boolean> {
    if (log.blockNumber == null) return true;
    const block = await this.contractReader.publicClient.getBlock({ blockNumber: BigInt(log.blockNumber) });
    return Number(block.timestamp) <= Math.floor(Date.now() / 1000) - seconds;
  }

  /** What /confirm does for the user: record the hash and create the Asset rows still pending in metadata. */
  private async bindContributionHash(transaction: Transaction, txHash: string, createAssets: boolean): Promise<void> {
    if (!transaction.tx_hash) {
      // Claim the row first so a late /confirm cannot create the same Asset rows again.
      const claimed = await this.transactionsRepository.update(
        { id: transaction.id, tx_hash: IsNull() },
        { tx_hash: txHash, status: TransactionStatus.submitted }
      );
      if ((claimed.affected ?? 0) > 0 && createAssets) await this.transactionsService.createAssets(transaction.id);
      transaction.tx_hash = txHash;
    } else if (transaction.tx_hash !== txHash) {
      // One more asset of an already confirmed contribution; record it where the parent lookup finds it.
      const fresh = await this.transactionsRepository.findOne({ where: { id: transaction.id } });
      const meta = (fresh?.metadata ?? {}) as Record<string, unknown>;
      const base = Array.isArray(meta) ? { assets: meta } : meta;
      const children = Array.isArray(base.evmChildTxHashes) ? (base.evmChildTxHashes as string[]) : [];
      if (!children.includes(txHash)) {
        await this.transactionsRepository.update(
          { id: transaction.id },
          { metadata: { ...base, evmChildTxHashes: [...children, txHash] } }
        );
      }
    }
    this.logger.warn(
      `ContributionMade tx=${txHash} was submitted outside the confirm flow; bound to transaction ${transaction.id}`
    );
  }

  // ---------------------------------------------------------------------------
  // PositionOpened / PositionClosed
  // ---------------------------------------------------------------------------

  private async handlePositionOpened(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const positionId = String(args.positionId as bigint);
    const adapter = (args.adapter as string).toLowerCase();
    const underlyingAsset = ((args.underlyingAsset as string) || '').toLowerCase();
    const amountConsumed = String(args.amountConsumed as bigint);
    const positionAsset = (args.positionAsset as string).toLowerCase();
    const positionAmount = String(args.positionAmount as bigint);
    const operationId = args.operationId as string | undefined;

    // Look up the admin Transaction that broadcast openPosition for this vault.
    const tx = await this.transactionsRepository.findOne({
      where: { vault_id: vault.id, tx_hash: log.txHash },
    });

    const existing = await this.positionsRepository.findOne({
      where: { vault_id: vault.id, on_chain_position_id: positionId },
    });

    if (existing) {
      // Idempotent — webhook replayed or duplicate log.
      return;
    }

    const position = this.positionsRepository.create({
      vault_id: vault.id,
      open_tx_id: tx?.id ?? undefined,
      on_chain_position_id: positionId,
      adapter,
      protocol: tx?.metadata ? (tx.metadata as any)?.protocol : undefined,
      underlying_asset: underlyingAsset || '0x0000000000000000000000000000000000000000',
      amount_deposited: amountConsumed,
      position_asset: positionAsset,
      position_amount: positionAmount,
      status: EvmPositionStatus.active,
      operation_id: operationId ?? undefined,
      open_tx_hash: log.txHash,
      open_block_number: log.blockNumber != null ? String(log.blockNumber) : undefined,
    });

    await this.positionsRepository.save(position);
    this.logger.log(`PositionOpened: vault=${vault.id} positionId=${positionId} adapter=${adapter} tx=${log.txHash}`);
  }

  /**
   * Termination-phase bookkeeping.
   *
   * These events do not drive any state machine — the contract is the source of
   * truth and every figure is readable from it — so this only maintains
   * `vault.termination_metadata.evm` for the UI and for operator visibility.
   * The one thing worth surfacing loudly is the claim deadline: after it,
   * holders permanently cannot redeem.
   */
  /**
   * DistributionClaimed(distributionId, holder, recipient, asset, amount)
   *
   * Records a pro-rata distribution payout as a Claim row so it appears in the
   * user's claim history alongside Cardano distributions. The claim is written
   * as already CLAIMED: unlike the Cardano flow, where the backend owes the
   * holder a payout it still has to make, here the holder (or the admin on
   * their behalf) has already pulled the funds out of the vault contract. This
   * is a record of something that happened, not a promise of something owed.
   *
   * Idempotent on (vault, proposal, user, distributionId) so a replayed log or
   * an overlapping reconciler range cannot duplicate the row.
   */
  private async handleDistributionClaimed(
    vault: Vault,
    log: VaultLogInput,
    args: Record<string, unknown>
  ): Promise<void> {
    const distributionId = String(args.distributionId as bigint);
    const holder = String(args.holder as Address).toLowerCase();
    const asset = String(args.asset as Address).toLowerCase();
    const amount = String(args.amount as bigint);

    // Match on the on-chain id rather than assuming the newest proposal: a
    // vault can have several distributions open at once.
    const matching = await this.findProposalForDistribution(vault.id, distributionId);

    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .where('LOWER(user.address) = :addr', { addr: holder })
      .getOne();

    const claimsRepository = this.dataSource.getRepository(Claim);
    // Keyed on the on-chain (distributionId, holder): holders without an account have no
    // user_id, and an undefined user_id in a TypeORM `where` matches any row.
    const existing = await claimsRepository
      .createQueryBuilder('c')
      .where('c.vault_id = :vaultId', { vaultId: vault.id })
      .andWhere('c.type = :type', { type: ClaimType.DISTRIBUTION })
      .andWhere("c.metadata ->> 'evmDistributionId' = :distributionId", { distributionId })
      .andWhere("c.metadata ->> 'evmHolder' = :holder", { holder })
      .getOne();
    if (existing) {
      return; // already recorded
    }

    await claimsRepository.save(
      claimsRepository.create({
        vault_id: vault.id,
        user_id: user?.id ?? null,
        proposal_id: matching?.id ?? null,
        type: ClaimType.DISTRIBUTION,
        status: ClaimStatus.CLAIMED,
        amount,
        description: `Pro-rata distribution ${distributionId}`,
        metadata: {
          evmDistributionId: distributionId,
          evmAsset: asset,
          evmHolder: holder,
          evmRecipient: String(args.recipient as Address).toLowerCase(),
          evmTxHash: log.txHash,
        } satisfies EvmDistributionClaimMetadata,
      })
    );

    this.logger.log(
      `DistributionClaimed vault=${vault.id} distribution=${distributionId} holder=${holder} amount=${amount} tx=${log.txHash}`
    );
  }

  /** Locate the proposal that opened `distributionId` for this vault. */
  private async findProposalForDistribution(vaultId: string, distributionId: string): Promise<Proposal | null> {
    return this.dataSource
      .getRepository(Proposal)
      .createQueryBuilder('p')
      .where('p.vault_id = :vaultId', { vaultId })
      .andWhere("p.metadata -> 'evmDistribution' ->> 'distributionId' = :did", { did: distributionId })
      .getOne();
  }

  /**
   * Index-vault basket trade. The swap service is the primary writer; this is
   * the durable path for a swap whose receipt never came back (RPC timeout
   * after broadcast), which would otherwise leave the transaction row
   * unreconciled forever with its `Swapped` expectation unmet.
   *
   * The leg is adopted only while no worker owns the run — an executing run
   * rewrites the whole `legs` array as it plans, and a write from here could
   * clobber it. An executing run's own retry re-adopts the leg from chain via
   * `isSwapOperationIdUsed`, so nothing is lost by leaving it alone.
   */
  private async handleSwapped(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const operationId = String(args.operationId ?? '').toLowerCase();
    if (!operationId) return;

    const run = await this.rebalancesRepository
      .createQueryBuilder('r')
      .where('r.vault_id = :vaultId', { vaultId: vault.id })
      .andWhere('r.legs @> :probe::jsonb', { probe: JSON.stringify([{ operationId }]) })
      .getOne();

    if (!run) {
      this.logger.log(`Vault ${vault.id}: Swapped ${operationId} matches no rebalance leg (tx=${log.txHash})`);
      return;
    }
    if (run.status === IndexRebalanceStatus.executing) {
      this.logger.log(`Vault ${vault.id}: Swapped ${operationId} left to the running rebalance ${run.id}`);
      return;
    }

    const leg = run.legs.find(l => l.operationId?.toLowerCase() === operationId);
    if (!leg || leg.status === IndexLegStatus.confirmed) return;

    leg.status = IndexLegStatus.confirmed;
    leg.txHash = log.txHash;
    leg.grossOut = String(args.grossOut ?? '0');
    leg.fee = String(args.fee ?? '0');
    leg.error = 'adopted: Swapped reconciled from chain';
    await this.rebalancesRepository.update({ id: run.id }, { legs: run.legs });
    this.logger.log(`Vault ${vault.id}: adopted leg ${leg.index} of rebalance ${run.id} from ${log.txHash}`);
  }

  private async handleTerminationEvent(
    vault: Vault,
    log: VaultLogInput,
    eventName: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const current = await this.vaultsRepository.findOne({ where: { id: vault.id } });
    if (!current) return;

    const meta = current.termination_metadata ?? ({} as NonNullable<Vault['termination_metadata']>);
    const evm = meta.evm;

    switch (eventName) {
      case 'TerminationCommitted': {
        const deadline = String((args.terminationDeadline as bigint) ?? 0n);
        meta.evm = {
          ...(evm ?? {
            phase: 'claim_window_open',
            valuationHash: String(args.valuationHash ?? ''),
            vtSupply: String((args.vtSupply as bigint) ?? 0n),
            terminationDeadline: deadline,
            sweepDelaySeconds: '0',
            committedAt: new Date().toISOString(),
            assets: [],
            waived: [],
          }),
          phase: 'claim_window_open',
          terminationDeadline: deadline,
        };
        this.logger.log(
          `Vault ${vault.id}: termination committed, claim window closes at ${deadline} (tx=${log.txHash})`
        );
        break;
      }
      case 'TerminationAssetDeferred': {
        if (!evm) return;
        const asset = String(args.asset).toLowerCase();
        const set = new Set([...(evm.deferredAssets ?? []), asset]);
        meta.evm = { ...evm, deferredAssets: [...set] };
        this.logger.warn(`Vault ${vault.id}: termination asset ${asset} deferred — entitlements still accrue`);
        break;
      }
      case 'TerminationAssetResumed': {
        if (!evm) return;
        const asset = String(args.asset).toLowerCase();
        meta.evm = { ...evm, deferredAssets: (evm.deferredAssets ?? []).filter(a => a !== asset) };
        break;
      }
      case 'TerminationRemainderSwept': {
        if (!evm) return;
        const asset = String(args.asset).toLowerCase();
        const set = new Set([...(evm.sweptAssets ?? []), asset]);
        meta.evm = { ...evm, phase: 'claim_window_closed', sweptAssets: [...set] };
        break;
      }
      // Redeemed / RedemptionDeferred / DeferredClaimed carry no metadata we
      // need to persist — outstanding supply and per-holder entitlements are
      // both readable on-chain. Logged so the reconciler records them as
      // applied rather than repeatedly reprocessing them.
      default:
        this.logger.debug?.(`Vault ${vault.id}: ${eventName} (tx=${log.txHash})`);
        return;
    }

    await this.vaultsRepository.update({ id: vault.id }, { termination_metadata: meta });
  }

  private async handlePositionClosed(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const positionId = String(args.positionId as bigint);
    const underlyingReturned = String(args.underlyingReturned as bigint);

    const existing = await this.positionsRepository.findOne({
      where: { vault_id: vault.id, on_chain_position_id: positionId },
    });

    if (!existing) {
      // Position row may not exist yet if webhook fires before reconciler created it.
      this.logger.warn(
        `PositionClosed: no DB row for vault=${vault.id} positionId=${positionId} tx=${log.txHash}. Will retry via backfill.`
      );
      return;
    }

    if (existing.status === EvmPositionStatus.closed) {
      return; // Already reconciled.
    }

    const tx = await this.transactionsRepository.findOne({
      where: { vault_id: vault.id, tx_hash: log.txHash },
    });

    await this.positionsRepository.update(
      { id: existing.id },
      {
        status: EvmPositionStatus.closed,
        underlying_returned: underlyingReturned,
        close_tx_id: tx?.id ?? undefined,
        close_tx_hash: log.txHash,
        close_block_number: log.blockNumber != null ? String(log.blockNumber) : undefined,
      }
    );

    this.logger.log(
      `PositionClosed: vault=${vault.id} positionId=${positionId} returned=${underlyingReturned} tx=${log.txHash}`
    );
  }

  private tryDecode(log: VaultLogInput): { eventName: string; args: Record<string, unknown> } | null {
    if (!log.topics || log.topics.length === 0) return null;
    try {
      const decoded = decodeEventLog({
        abi: VAULT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
      return { eventName: decoded.eventName, args: decoded.args as Record<string, unknown> };
    } catch {
      return null;
    }
  }

  private diffFields(
    fromEvent: {
      contributor: string;
      kind: number;
      asset: string;
      tokenId: string;
      amount: string;
      cycleId: string;
    },
    row: EvmContribution
  ): string[] {
    const out: string[] = [];
    if (row.contributor.toLowerCase() !== fromEvent.contributor)
      out.push(`contributor(event=${fromEvent.contributor}, DB=${row.contributor})`);
    if (row.kind !== fromEvent.kind) out.push(`kind(event=${fromEvent.kind}, DB=${row.kind})`);
    if (row.asset.toLowerCase() !== fromEvent.asset) out.push(`asset(event=${fromEvent.asset}, DB=${row.asset})`);
    if (String(row.token_id) !== fromEvent.tokenId) out.push(`tokenId(event=${fromEvent.tokenId}, DB=${row.token_id})`);
    if (String(row.amount) !== fromEvent.amount) out.push(`amount(event=${fromEvent.amount}, DB=${row.amount})`);
    if (String(row.cycle_id) !== fromEvent.cycleId) out.push(`cycleId(event=${fromEvent.cycleId}, DB=${row.cycle_id})`);
    return out;
  }

  private assetMatches(
    meta: Record<string, unknown>,
    kind: number,
    asset: string,
    tokenId: string,
    amount: string
  ): boolean {
    const metaPolicy = String(meta.policyId ?? '').toLowerCase();
    const metaKindStr = String(meta.standard ?? meta.type ?? '').toUpperCase();
    const metaKind = this.parseKind(metaKindStr);

    if (metaKind !== null && metaKind !== kind) return false;

    if (kind === EvmAssetKindOnchain.Native) {
      const zero = '0x' + '00'.repeat(20);
      if (metaPolicy && metaPolicy !== zero) return false;
    } else if (metaPolicy && metaPolicy !== asset) {
      return false;
    }

    if (kind === EvmAssetKindOnchain.ERC721 || kind === EvmAssetKindOnchain.ERC1155) {
      const metaTokenId = meta.tokenId ?? meta.assetName;
      if (metaTokenId != null && String(metaTokenId) !== tokenId) return false;
    }

    if (kind !== EvmAssetKindOnchain.ERC721) {
      const metaQty = meta.quantity ?? meta.amount;
      if (metaQty != null && String(metaQty) !== amount) return false;
    }

    return true;
  }

  private parseKind(s: string): number | null {
    switch (s) {
      case 'NATIVE':
      case 'ETH':
        return EvmAssetKindOnchain.Native;
      case 'ERC20':
      case 'FT':
        return EvmAssetKindOnchain.ERC20;
      case 'ERC721':
      case 'NFT':
        return EvmAssetKindOnchain.ERC721;
      case 'ERC1155':
        return EvmAssetKindOnchain.ERC1155;
      default:
        return null;
    }
  }
}
