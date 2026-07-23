import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
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
import { TransactionStatus } from '@/types/transaction.types';

/**
 * Shape of a single log after Alchemy webhook decoding. Callers should pass
 * the emitting contract's address alongside the log payload so the
 * reconciler can enforce vault-address checks.
 */
export interface VaultLogInput {
  address: string;
  data: string;
  topics: string[];
  txHash: string;
  blockNumber?: number | string | bigint | null;
  logIndex?: number | null;
}

/**
 * Reconciler for the five V3 vault events (ContributionMade, ContributionCancelled,
 * CycleClosed, CycleStatusChanged, AllocationClaimed).
 *
 * Design:
 *   - The webhook path is a RECONCILIATION path. The primary writer for
 *     `EvmContribution` / `EvmValuationSnapshot` / `EvmAllocation` mutations is
 *     the operation service (contribution flow, EvmCycleCloseService, airdrop /
 *     refund orchestrators). Every handler in this file is therefore idempotent
 *     and a no-op when the DB already reflects the on-chain state.
 *
 *   - Every mutation is guarded by the unique key the contract already
 *     enforces on-chain:
 *       * (vault_id, on_chain_contribution_id) for contribution rows
 *       * (vault_id, cycle_id, claim_index)    for allocation rows
 *       * (vault_id, cycle_id)                 for snapshot rows
 *
 *   - Fields decoded from the log are validated against the DB row that the
 *     operation service persisted. A mismatch is logged as a hard error;
 *     the DB is NOT overwritten because the webhook cannot know which side
 *     is correct without more context.
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
  async reconcileLogs(logs: VaultLogInput[]): Promise<{ processed: number; skipped: number; errors: number }> {
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    // Pre-resolve vault records by contract address so we don't hit the DB
    // once per log.
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
            processed++;
            break;
          case 'ContributionCancelled':
            await this.handleContributionCancelled(vault, log, decoded.args);
            processed++;
            break;
          case 'CycleClosed':
            await this.handleCycleClosed(vault, log, decoded.args);
            processed++;
            break;
          case 'CycleStatusChanged':
            await this.handleCycleStatusChanged(vault, log, decoded.args);
            processed++;
            break;
          case 'AllocationClaimed':
            await this.handleAllocationClaimed(vault, log, decoded.args);
            processed++;
            break;
          default:
            skipped++;
        }
      } catch (err) {
        errors++;
        this.logger.error(`Failed to reconcile log (tx=${log.txHash}, addr=${log.address}): ${(err as Error).message}`);
      }
    }

    return { processed, skipped, errors };
  }

  // -------------------------------------------------------------------------
  // Per-event handlers
  // -------------------------------------------------------------------------

  /**
   * ContributionMade(contributionId, cycleId, contributor, kind, asset, tokenId, amount)
   *
   * Match against the parent DB Transaction by tx_hash. Then upsert an
   * EvmContribution row keyed by (vault_id, on_chain_contribution_id).
   *
   * Strict validation: an upsert is only performed after every field
   * (vault, cycle, contributor, kind, asset, tokenId, amount) matches what
   * we expected from the Transaction's metadata / user address. Cross-vault
   * or cross-asset mismatches raise an error and skip the write.
   */
  private async handleContributionMade(vault: Vault, log: VaultLogInput, args: Record<string, unknown>): Promise<void> {
    const contributionId = String(args.contributionId as bigint);
    const cycleId = String(args.cycleId as bigint);
    const contributor = String(args.contributor as Address).toLowerCase();
    const kind = Number(args.kind);
    const asset = String(args.asset as Address).toLowerCase();
    const tokenId = String(args.tokenId as bigint);
    const amount = String(args.amount as bigint);

    // Already reconciled? Idempotent no-op.
    const existing = await this.contribsRepository.findOne({
      where: { vault_id: vault.id, on_chain_contribution_id: contributionId },
    });
    if (existing) {
      // Strict cross-check for defense in depth.
      const drift = this.diffFields({ contributor, kind, asset, tokenId, amount, cycleId }, existing);
      if (drift.length > 0) {
        this.logger.error(
          `ContributionMade drift on existing row ${existing.id} tx=${log.txHash}: ${drift.join('; ')}. Skipping write.`
        );
      }
      return;
    }

    // Find the parent DB Transaction created by the contribution flow.
    const transaction = await this.transactionsRepository.findOne({
      where: { tx_hash: log.txHash, vault_id: vault.id },
      relations: ['user'],
    });
    if (!transaction) {
      this.logger.warn(
        `ContributionMade tx=${log.txHash} contributionId=${contributionId}: ` +
          `no matching DB Transaction for vault ${vault.id}. Skipping — cannot bind.`
      );
      return;
    }

    // Contributor must match Transaction.user.address.
    const userAddr = transaction.user?.address?.toLowerCase();
    if (!userAddr) {
      this.logger.error(
        `ContributionMade tx=${log.txHash}: transaction ${transaction.id} has no user.address. Skipping.`
      );
      return;
    }
    if (userAddr !== contributor) {
      this.logger.error(
        `ContributionMade tx=${log.txHash} contributor mismatch: ` +
          `event=${contributor}, tx.user=${userAddr}. Skipping write.`
      );
      return;
    }

    // Look for a matching asset row inside the transaction's metadata.
    // Metadata shape: array of assets OR { assets: [...], evmChildTxHashes: [...] }.
    const rawMeta = transaction.metadata as unknown;
    const metaAssets: Array<Record<string, unknown>> = Array.isArray(rawMeta)
      ? (rawMeta as Array<Record<string, unknown>>)
      : Array.isArray((rawMeta as { assets?: unknown[] })?.assets)
        ? (rawMeta as { assets: Array<Record<string, unknown>> }).assets
        : [];
    const matchingAsset = metaAssets.find(a => this.assetMatches(a, kind, asset, tokenId, amount));
    if (!matchingAsset && metaAssets.length > 0) {
      // We had metadata but nothing lines up. Refuse to write until an
      // operator investigates.
      this.logger.error(
        `ContributionMade tx=${log.txHash} contributionId=${contributionId}: ` +
          `no matching asset in Transaction.metadata (kind=${kind}, asset=${asset}, tokenId=${tokenId}, amount=${amount}). ` +
          `Skipping write.`
      );
      return;
    }

    // Optional: look up matching Asset row (may not exist yet — createAssets
    // runs after webhook confirms tx). Best-effort.
    const assetRow = await this.assetsRepository.findOne({
      where: {
        transaction: { id: transaction.id },
        policy_id: asset,
      },
    });

    // Upsert. Race protection: the UNIQUE (vault_id, on_chain_contribution_id)
    // constraint means concurrent inserts serialize; the second one throws
    // and gets treated as a no-op by the caller's try/catch.
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
      // Unique-key violation is expected under a race; anything else re-throws.
      if ((err as { code?: string }).code === '23505') {
        this.logger.debug(`ContributionMade contributionId=${contributionId} raced; already inserted`);
        return;
      }
      throw err;
    }
  }

  /**
   * ContributionCancelled(contributionId, contributor)
   *
   * Mark the EvmContribution row refunded. Then roll up the parent
   * Transaction if ALL of its child EvmContributions are refunded.
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
      // We haven't seen the ContributionMade yet, or it wasn't ours. Warn only.
      this.logger.warn(
        `ContributionCancelled tx=${log.txHash} contributionId=${contributionId}: ` +
          `no EvmContribution row for vault ${vault.id}. Skipping.`
      );
      return;
    }
    if (row.status === EvmContributionRowStatus.refunded) {
      // Already reconciled by a prior webhook redelivery or the admin path.
      return;
    }
    // Cross-check contributor before writing.
    if (row.contributor.toLowerCase() !== contributor) {
      this.logger.error(
        `ContributionCancelled tx=${log.txHash} contributor mismatch: ` +
          `event=${contributor}, DB=${row.contributor}. Skipping write.`
      );
      return;
    }

    await this.dataSource.transaction(async manager => {
      // Atomic: only flip if still active.
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

      // Mark the underlying Asset row REFUNDED if present.
      if (row.asset_id) {
        await manager.update(Asset, { id: row.asset_id }, { status: AssetStatus.REFUNDED, updated_at: new Date() });
      }

      // Roll up the parent Transaction if all sibling contributions refunded.
      const remainingActive = await manager.count(EvmContribution, {
        where: {
          transaction_id: row.transaction_id,
          status: EvmContributionRowStatus.active,
        },
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
   * Cross-check against our EvmValuationSnapshot. On exact match: promote
   * the snapshot to `confirmed` and set vault.evm_root_committed_at.
   * On mismatch: mark `reconciliation_required` (never overwrite blindly).
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
      // The cycle was closed on-chain but we have no snapshot. Someone
      // bypassed the admin flow (dev tool, direct tx). Log loudly.
      this.logger.error(
        `CycleClosed for vault ${vault.id} cycle ${cycleId} tx=${log.txHash} has NO local snapshot. ` +
          `Root=${allocationRoot} was committed without our involvement.`
      );
      return;
    }

    if (snapshot.status === EvmSnapshotStatus.confirmed) {
      // Already reconciled.
      return;
    }

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
        // Only set vault fields on the FIRST confirm — never overwrite once set.
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

    // Mismatch: mark for operator intervention.
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
    this.logger.error(
      `CycleClosed MISMATCH vault=${vault.id} cycle=${cycleId} tx=${log.txHash}: ${diffs.join('; ')}. ` +
        `Snapshot ${snapshot.id} marked reconciliation_required.`
    );
  }

  /**
   * CycleStatusChanged(cycleId, newStatus)
   *
   * Track admin `cancelCurrentCycle()` calls (newStatus=Cancelled) even if
   * they weren't initiated by our admin service. Informational for Locked;
   * cross-checked by handleCycleClosed which is the authoritative source.
   */
  private async handleCycleStatusChanged(
    vault: Vault,
    log: VaultLogInput,
    args: Record<string, unknown>
  ): Promise<void> {
    const cycleId = String(args.cycleId as bigint);
    const newStatus = Number(args.newStatus);

    if (newStatus !== EvmCycleStatus.Cancelled) {
      // Locked is redundant with CycleClosed; Active only fires on openCycle
      // which we don't track yet.
      return;
    }

    if (vault.evm_cancel_cycle_tx_hash) {
      // Already recorded (probably by admin path).
      return;
    }
    await this.vaultsRepository
      .createQueryBuilder()
      .update(Vault)
      .set({ evm_cancel_cycle_tx_hash: log.txHash })
      .where('id = :id AND evm_cancel_cycle_tx_hash IS NULL', { id: vault.id })
      .execute();
    this.logger.warn(
      `CycleStatusChanged(Cancelled) vault=${vault.id} cycle=${cycleId} tx=${log.txHash} recorded via webhook`
    );
  }

  /**
   * AllocationClaimed(cycleId, claimIndex, contributor, vtAmount, nativeAmount)
   *
   * Mark the corresponding EvmAllocation row claimed. Validated by:
   *   - (vault_id, cycle_id, claim_index) locates the row.
   *   - contributor + vtAmount + nativeAmount must match the row.
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
      this.logger.error(
        `AllocationClaimed vault=${vault.id} cycle=${cycleId} claimIndex=${claimIndex} tx=${log.txHash}: ` +
          `no allocation row. Someone claimed against an unknown root.`
      );
      return;
    }
    if (row.claimed_at) {
      // Idempotent no-op.
      return;
    }
    if (
      row.contributor.toLowerCase() !== contributor ||
      row.vt_amount !== vtAmount ||
      row.native_amount !== nativeAmount
    ) {
      this.logger.error(
        `AllocationClaimed MISMATCH row=${row.id} tx=${log.txHash}: ` +
          `contributor(event=${contributor}, DB=${row.contributor}) ` +
          `vt(event=${vtAmount}, DB=${row.vt_amount}) native(event=${nativeAmount}, DB=${row.native_amount}). ` +
          `Skipping write.`
      );
      return;
    }

    // Atomic: only flip if still unclaimed.
    await this.allocationsRepository
      .createQueryBuilder()
      .update(EvmAllocation)
      .set({ claimed_at: new Date(), claim_tx_hash: log.txHash })
      .where('id = :id AND claimed_at IS NULL', { id: row.id })
      .execute();

    this.logger.log(
      `AllocationClaimed reconciled: vault=${vault.id} cycle=${cycleId} claimIndex=${claimIndex} tx=${log.txHash}`
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private tryDecode(log: VaultLogInput): { eventName: string; args: Record<string, unknown> } | null {
    if (!log.topics || log.topics.length === 0) return null;
    try {
      const decoded = decodeEventLog({
        abi: VAULT_ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      }) as { eventName: string; args: unknown };
      return {
        eventName: decoded.eventName,
        args: decoded.args as Record<string, unknown>,
      };
    } catch {
      // Log doesn't belong to VAULT_ABI (e.g. ERC-20 Transfer) — skip.
      return null;
    }
  }

  private diffFields(
    fromEvent: { contributor: string; kind: number; asset: string; tokenId: string; amount: string; cycleId: string },
    row: EvmContribution
  ): string[] {
    const out: string[] = [];
    if (row.contributor.toLowerCase() !== fromEvent.contributor)
      out.push(`contributor(event=${fromEvent.contributor}, DB=${row.contributor})`);
    if (row.kind !== fromEvent.kind) out.push(`kind(event=${fromEvent.kind}, DB=${row.kind})`);
    if (row.asset.toLowerCase() !== fromEvent.asset) out.push(`asset(event=${fromEvent.asset}, DB=${row.asset})`);
    if (row.token_id !== fromEvent.tokenId) out.push(`tokenId(event=${fromEvent.tokenId}, DB=${row.token_id})`);
    if (row.amount !== fromEvent.amount) out.push(`amount(event=${fromEvent.amount}, DB=${row.amount})`);
    if (row.cycle_id !== fromEvent.cycleId) out.push(`cycleId(event=${fromEvent.cycleId}, DB=${row.cycle_id})`);
    return out;
  }

  /**
   * Very lightweight metadata-vs-event asset match. Metadata rows from the
   * contribution flow carry {policyId, assetName, type/kind, quantity}. This
   * check is best-effort — the strong invariant is the ContributionMade
   * event itself, which came from the vault contract we trust.
   */
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

    // For native contributions the asset address is 0x0 and metadata often lacks it.
    if (kind === EvmAssetKindOnchain.Native) {
      const zero = '0x' + '00'.repeat(20);
      if (metaPolicy && metaPolicy !== zero) return false;
    } else if (metaPolicy && metaPolicy !== asset) {
      return false;
    }

    // tokenId check for ERC721/1155.
    if (kind === EvmAssetKindOnchain.ERC721 || kind === EvmAssetKindOnchain.ERC1155) {
      const metaTokenId = meta.tokenId ?? meta.assetName;
      if (metaTokenId != null && String(metaTokenId) !== tokenId) return false;
    }

    // Amount check (skip for ERC721 which is always 1).
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
