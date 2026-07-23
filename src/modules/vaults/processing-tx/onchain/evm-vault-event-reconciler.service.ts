import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { decodeEventLog, type Address, type Hex } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { EvmCycleCloseService } from './evm-cycle-close.service';
import { EvmAssetKindOnchain, EvmCycleStatus, VAULT_ABI } from './vault.abi';

import { Asset } from '@/database/asset.entity';
import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { AssetStatus } from '@/types/asset.types';
import { ExpectedEventSpec, TransactionStatus } from '@/types/transaction.types';

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
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly cycleCloseService: EvmCycleCloseService
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
    const recordApplied = (hash: string, event: string) => {
      const e = outcome(hash);
      e.applied.set(event, (e.applied.get(event) ?? 0) + 1);
    };
    const recordError = (hash: string, msg: string) => {
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
          default:
            skipped++;
        }
      } catch (err) {
        errors++;
        const msg = (err as Error).message;
        this.logger.error(`Failed to reconcile log (tx=${log.txHash}, addr=${log.address}): ${msg}`);
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
      return;
    }

    const transaction = await this.findParentTransactionForContribution(vault.id, log.txHash);
    if (!transaction) {
      // No parent Transaction row means the contribution happened outside our
      // prepare-tx flow (nobody uses this codepath today — all contributions
      // originate via /vaults/blockchain/evm/contribute/prepare which creates
      // a Transaction row). Skip quietly rather than error every cron tick.
      this.logger.debug(
        `ContributionMade contributionId=${contributionId} tx=${log.txHash} vault=${vault.id}: ` +
          `no parent Transaction — skipping (third-party direct call)`
      );
      return;
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

    const assetRow = await this.assetsRepository.findOne({
      where: { transaction: { id: transaction.id }, policy_id: asset },
    });

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
        await manager.update(Asset, { id: row.asset_id }, { status: AssetStatus.REFUNDED, updated_at: new Date() });
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
    await this.vaultsRepository
      .createQueryBuilder()
      .update(Vault)
      .set({ evm_cancel_cycle_tx_hash: log.txHash })
      .where('id = :id AND evm_cancel_cycle_tx_hash IS NULL', { id: vault.id })
      .execute();
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
