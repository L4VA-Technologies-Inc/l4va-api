import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmCycleStatus, EvmVaultOnchainStatus, VAULT_ABI } from './vault.abi';

import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import {
  EvmReconciliationStatus,
  ExpectedEventSpec,
  TransactionStatus,
  TransactionType,
} from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

/**
 * Broadcast + reconciliation half of Phase B.
 *
 * Status machine driven from this service:
 *
 *   ready → submitting → submitted(hash) → confirmed
 *                                        └─ reconciliation_required
 *                                        └─ failed
 *
 * Transitions:
 *  - ready → submitting: atomic UPDATE gate (prevents concurrent replicas).
 *  - submitting → submitted(hash): persisted via onBroadcast callback THE MOMENT
 *    writeContract returns, BEFORE waiting for the receipt. This guarantees a
 *    crash between broadcast and receipt is recoverable (reconciler picks up
 *    submitted-with-hash rows).
 *  - submitted → confirmed: receipt succeeded AND the CycleClosed event was
 *    emitted by the correct address AND every arg exactly matches the snapshot.
 *  - submitted → reconciliation_required: receipt succeeded but events missing
 *    or mismatched. Tx hash is retained; reconciler re-reads on-chain state.
 *  - submitted → failed: simulate/broadcast/receipt reverted.
 *
 * Concurrency: The atomic UPDATE gate on `status='ready' → 'submitting'` is
 * the only concurrency primitive we need. In-process `processingVaults` in
 * LifecycleService is a soft optimization; the DB gate is the correctness
 * bound across replicas.
 */
@Injectable()
export class EvmCycleCloseService {
  private readonly logger = new Logger(EvmCycleCloseService.name);

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  /**
   * Close the given cycle on-chain. Idempotent + concurrency-safe.
   * Callers may invoke this from the LifecycleService cron OR a manual admin
   * endpoint; both paths converge through the same DB gate.
   */
  async closeCycleForVault(vaultId: string, cycleId: bigint): Promise<{ txHash: Hex; snapshotId: string }> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }

    const vaultAddress = vault.contract_address as Address;

    // Idempotency: if snapshot already confirmed, exit early.
    const pre = await this.snapshotsRepository.findOne({
      where: { vault_id: vaultId, cycle_id: cycleId.toString() },
    });
    if (!pre) {
      throw new BadRequestException(
        `No snapshot exists for vault ${vaultId} cycle ${cycleId}. Run EvmAllocationService.computeSnapshot first.`
      );
    }
    if (pre.status === EvmSnapshotStatus.confirmed) {
      this.logger.log(`Cycle ${cycleId} already confirmed for vault ${vaultId} — no-op`);
      return { txHash: pre.submit_tx_hash as Hex, snapshotId: pre.id };
    }
    if (pre.status === EvmSnapshotStatus.submitted || pre.status === EvmSnapshotStatus.submitting) {
      throw new BadRequestException(
        `Snapshot ${pre.id} is in status '${pre.status}' (in-flight or awaiting reconciliation). ` +
          `Use reconcileFromChain(snapshotId=${pre.id}) instead.`
      );
    }
    if (pre.status === EvmSnapshotStatus.reconciliation_required) {
      throw new BadRequestException(
        `Snapshot ${pre.id} needs reconciliation. Use reconcileFromChain(snapshotId=${pre.id}).`
      );
    }
    if (pre.status !== EvmSnapshotStatus.ready) {
      throw new BadRequestException(
        `Snapshot ${pre.id} is in status '${pre.status}'; must be 'ready' to close the cycle`
      );
    }

    // ── Atomic gate: ready → submitting (single writer only) ────────────────
    // If another replica or a concurrent manual request already flipped this,
    // affected will be 0. Bail out — that other worker owns the broadcast.
    const gate = await this.snapshotsRepository
      .createQueryBuilder()
      .update(EvmValuationSnapshot)
      .set({ status: EvmSnapshotStatus.submitting })
      .where('id = :id AND status = :expected', { id: pre.id, expected: EvmSnapshotStatus.ready })
      .execute();
    if ((gate.affected ?? 0) === 0) {
      throw new BadRequestException(
        `Snapshot ${pre.id} concurrently transitioned out of 'ready'. Another worker owns the broadcast.`
      );
    }

    // Re-fetch to get the immutable expected values under the gate.
    const snapshot = await this.snapshotsRepository.findOne({ where: { id: pre.id } });
    if (!snapshot || !snapshot.merkle_root || !snapshot.valuation_hash) {
      // Should never happen — gate was set, but be defensive.
      await this.snapshotsRepository.update(
        { id: pre.id },
        { status: EvmSnapshotStatus.failed, failure_reason: 'snapshot vanished after ready→submitting gate' }
      );
      throw new Error(`Snapshot ${pre.id} inconsistent after gate`);
    }

    // On-chain preflight — cycle must be Active.
    const cycleView = await this.contractReader.getCycle(vaultAddress, cycleId);
    if (cycleView.status !== EvmCycleStatus.Active) {
      // Someone (admin, another job, or the contract itself) already advanced
      // the cycle. Kick to reconciliation so we compare roots on-chain.
      await this.snapshotsRepository.update(
        { id: snapshot.id },
        {
          status: EvmSnapshotStatus.reconciliation_required,
          failure_reason: `preflight: on-chain cycle status is ${EvmCycleStatus[cycleView.status]}, not Active`,
        }
      );
      throw new BadRequestException(
        `Cycle ${cycleId} on-chain status is ${EvmCycleStatus[cycleView.status]}. Reconciliation required.`
      );
    }

    const expectedRoot = snapshot.merkle_root as Hex;
    const expectedValuationHash = snapshot.valuation_hash as Hex;
    const expectedTotalVt = BigInt(snapshot.total_vt_allocation);
    const expectedTotalNative = BigInt(snapshot.total_native_allocation);

    // Create the admin Transaction row up front so the health-check cron
    // knows what events are expected on the receipt. reconciliation_status
    // = 'pending' is what makes the sweep pick this row up on retry.
    const adminTx = await this.createAdminTxRow({
      type: TransactionType.evmCloseCycle,
      vaultId,
      vault,
      expectedEvents: [{ name: 'CycleClosed', count: 1 }],
    });

    // ── simulate → broadcast → persist(hash) → wait → decode ─────────────────
    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: vaultAddress,
          abi: VAULT_ABI,
          functionName: 'closeCycle',
          args: [expectedRoot, expectedValuationHash, expectedTotalVt, expectedTotalNative],
        },
        ['CycleClosed'],
        // onBroadcast: persist hash on BOTH the snapshot AND the admin Tx row
        // BEFORE waiting for receipt. This makes the flow crash-safe.
        async (hash) => {
          await this.dataSource.transaction(async manager => {
            await manager.update(
              EvmValuationSnapshot,
              { id: snapshot.id },
              { status: EvmSnapshotStatus.submitted, submit_tx_hash: hash }
            );
            await manager.update(
              Transaction,
              { id: adminTx.id },
              { tx_hash: hash, status: TransactionStatus.submitted }
            );
          });
        }
      );
    } catch (err) {
      if (err instanceof TxRevertedError) {
        await this.dataSource.transaction(async manager => {
          await manager.update(
            EvmValuationSnapshot,
            { id: snapshot.id },
            {
              status: EvmSnapshotStatus.failed,
              submit_tx_hash: err.hash,
              failure_reason: `receipt reverted: ${err.message.slice(0, 500)}`,
            }
          );
          await manager.update(
            Transaction,
            { id: adminTx.id },
            {
              tx_hash: err.hash,
              status: TransactionStatus.failed,
              reconciliation_status: EvmReconciliationStatus.failed,
              reconciliation_last_error: err.message.slice(0, 500),
            }
          );
        });
        throw err;
      }
      // We may or may not have persisted a hash via onBroadcast. If we did,
      // route to reconciliation instead of hard-failing so a follow-up run
      // can compare on-chain root.
      const current = await this.snapshotsRepository.findOne({ where: { id: snapshot.id } });
      const reason = (err as Error).message || String(err);
      if (current?.submit_tx_hash) {
        await this.dataSource.transaction(async manager => {
          await manager.update(
            EvmValuationSnapshot,
            { id: snapshot.id },
            {
              status: EvmSnapshotStatus.reconciliation_required,
              failure_reason: `receipt wait failed with hash present: ${reason.slice(0, 500)}`,
            }
          );
          // Leave Transaction.reconciliation_status='pending' so the sweep retries.
          await manager.update(
            Transaction,
            { id: adminTx.id },
            { reconciliation_last_error: `receipt wait failed: ${reason.slice(0, 500)}` }
          );
        });
      } else {
        await this.dataSource.transaction(async manager => {
          await manager.update(
            EvmValuationSnapshot,
            { id: snapshot.id },
            { status: EvmSnapshotStatus.failed, failure_reason: `broadcast: ${reason.slice(0, 500)}` }
          );
          await manager.update(
            Transaction,
            { id: adminTx.id },
            {
              status: TransactionStatus.failed,
              reconciliation_status: EvmReconciliationStatus.failed,
              reconciliation_last_error: `broadcast failed: ${reason.slice(0, 500)}`,
            }
          );
        });
      }
      throw err;
    }

    // Receipt succeeded. Validate emitted event(s).
    await this.validateAndCommit(snapshot.id, adminTx.id, vaultAddress, vaultId, cycleId, result, {
      expectedRoot,
      expectedValuationHash,
      expectedTotalVt,
      expectedTotalNative,
    });

    return { txHash: result.hash, snapshotId: snapshot.id };
  }

  /**
   * Called when a snapshot is stuck in `submitting`, `submitted`, or
   * `reconciliation_required`. Reads the on-chain cycle and reconciles:
   *
   *  - If `getCycle(cycleId).allocationRoot === snapshot.merkle_root` AND totals
   *    match → promote to `confirmed`, write vault fields, no rebroadcast.
   *  - Else if cycle is still Active → back to `ready` (safe to retry).
   *  - Else → `failed` with reason.
   *
   * Never rebroadcasts. Never re-fetches events if the tx hash is unreliable.
   * Callers can safely invoke repeatedly.
   */
  async reconcileFromChain(snapshotId: string): Promise<{ status: EvmSnapshotStatus; onChainRoot: Hex }> {
    const snapshot = await this.snapshotsRepository.findOne({ where: { id: snapshotId } });
    if (!snapshot) throw new NotFoundException(`Snapshot ${snapshotId} not found`);

    const vault = await this.vaultsRepository.findOne({ where: { id: snapshot.vault_id } });
    if (!vault || !vault.contract_address) {
      throw new BadRequestException(`Vault ${snapshot.vault_id} not found or missing on-chain address`);
    }

    const cycleView = await this.contractReader.getCycle(vault.contract_address as Address, BigInt(snapshot.cycle_id));
    const onChainRoot = cycleView.allocationRoot as Hex;
    const zeroRoot = ('0x' + '00'.repeat(32)) as Hex;

    // Case 1: on-chain root matches — the tx landed and events were fine even
    // if we missed decoding them. Promote to confirmed.
    if (
      onChainRoot.toLowerCase() === (snapshot.merkle_root ?? '').toLowerCase() &&
      cycleView.totalVtAllocation === BigInt(snapshot.total_vt_allocation) &&
      cycleView.totalNativeAllocation === BigInt(snapshot.total_native_allocation) &&
      cycleView.status === EvmCycleStatus.Locked
    ) {
      await this.commitConfirmed(snapshot, null, vault.id, BigInt(snapshot.cycle_id), onChainRoot, snapshot.submit_tx_hash as Hex);
      this.logger.log(`Reconciled snapshot ${snapshotId} → confirmed (root matches on-chain)`);
      return { status: EvmSnapshotStatus.confirmed, onChainRoot };
    }

    // Case 2: on-chain root is zero AND cycle still Active → nothing landed,
    // safe to retry. Roll back to `ready`.
    if (onChainRoot === zeroRoot && cycleView.status === EvmCycleStatus.Active) {
      await this.snapshotsRepository.update(
        { id: snapshotId },
        { status: EvmSnapshotStatus.ready, failure_reason: `reconciler: on-chain still Active, no root committed` }
      );
      this.logger.log(`Reconciled snapshot ${snapshotId} → ready (no on-chain root, cycle still Active)`);
      return { status: EvmSnapshotStatus.ready, onChainRoot };
    }

    // Case 3: on-chain root exists but differs, OR cycle is Cancelled, OR
    // totals mismatch → hard fail. Never rebroadcast.
    await this.snapshotsRepository.update(
      { id: snapshotId },
      {
        status: EvmSnapshotStatus.failed,
        failure_reason:
          `reconciler mismatch: on-chain root=${onChainRoot}, expected=${snapshot.merkle_root}; ` +
          `on-chain cycleStatus=${EvmCycleStatus[cycleView.status]}, ` +
          `on-chain totalVt=${cycleView.totalVtAllocation}, expected=${snapshot.total_vt_allocation}, ` +
          `on-chain totalNative=${cycleView.totalNativeAllocation}, expected=${snapshot.total_native_allocation}`,
      }
    );
    this.logger.error(`Reconciled snapshot ${snapshotId} → failed (mismatch)`);
    return { status: EvmSnapshotStatus.failed, onChainRoot };
  }

  /**
   * Failed-vault path: admin `cancelCurrentCycle()`. Used when the acquire
   * threshold is not met.
   *
   * Does NOT compute a snapshot — cancel simply locks contributions for
   * refund via `refundContributions(...)` in Phase C.
   */
  async cancelCurrentCycle(vaultId: string, reason: string): Promise<{ txHash: Hex }> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }
    if (vault.evm_cancel_cycle_tx_hash) {
      throw new BadRequestException(
        `Vault ${vaultId} already has a cancel tx recorded (${vault.evm_cancel_cycle_tx_hash})`
      );
    }

    const vaultAddress = vault.contract_address as Address;

    // Preflight: on-chain vault status must be Active.
    const onchainStatus = (await this.contractReader.publicClient.readContract({
      address: vaultAddress,
      abi: VAULT_ABI,
      functionName: 'status',
    })) as number;
    if (onchainStatus !== EvmVaultOnchainStatus.Active) {
      throw new BadRequestException(
        `Vault ${vaultAddress} on-chain status is ${EvmVaultOnchainStatus[onchainStatus]}; must be Active to cancel`
      );
    }

    this.logger.log(`Cancelling current cycle for vault ${vaultId} (reason: ${reason})`);

    // Admin Tx row for reconciliation tracking.
    const adminTx = await this.createAdminTxRow({
      type: TransactionType.evmCancelCycle,
      vaultId,
      vault,
      expectedEvents: [{ name: 'CycleStatusChanged', count: 1 }],
    });

    const result = await this.adminSigner.sendAndConfirm(
      {
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'cancelCurrentCycle',
        args: [],
      },
      ['CycleStatusChanged'],
      // Persist the hash the moment we have it — on BOTH the vault and the tx row.
      async (hash) => {
        await this.dataSource.transaction(async manager => {
          await manager.update(Vault, { id: vaultId }, { evm_cancel_cycle_tx_hash: hash });
          await manager.update(
            Transaction,
            { id: adminTx.id },
            { tx_hash: hash, status: TransactionStatus.submitted }
          );
        });
      }
    );

    // Verify a CycleStatusChanged(., Cancelled) event was emitted by our vault.
    const evt = result.decodedEvents.find(
      e =>
        e.eventName === 'CycleStatusChanged' &&
        e.address.toLowerCase() === vaultAddress.toLowerCase() &&
        Number((e.args as { newStatus: number }).newStatus) === EvmCycleStatus.Cancelled
    );
    if (!evt) {
      // Success receipt but no matching event decoded — leave reconciliation
      // pending so the health-check cron re-fetches and resolves.
      await this.transactionsRepository.update(
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_last_error: `CycleStatusChanged(Cancelled) not decoded in receipt tx ${result.hash}`,
        }
      );
      this.logger.warn(
        `cancelCurrentCycle tx ${result.hash} confirmed but no CycleStatusChanged(Cancelled) event decoded. ` +
          `Hash persisted; health-check cron will reconcile.`
      );
    } else {
      // Happy path: mark tx confirmed AND reconciled.
      await this.transactionsRepository.update(
        { id: adminTx.id },
        {
          status: TransactionStatus.confirmed,
          reconciliation_status: EvmReconciliationStatus.success,
          reconciled_at: new Date(),
          reconciliation_last_error: null,
        }
      );
    }

    this.logger.log(`Cycle cancelled for vault ${vaultId}. tx=${result.hash}`);
    return { txHash: result.hash };
  }

  /**
   * Create a Transaction row for an admin-signed on-chain operation. Called
   * by every admin broadcast BEFORE simulate/send so that a crash between
   * broadcast and receipt leaves a diagnosable, retryable row for the
   * health-check cron.
   */
  private async createAdminTxRow(params: {
    type: TransactionType;
    vaultId: string;
    vault: Vault;
    expectedEvents: ExpectedEventSpec[];
  }): Promise<Transaction> {
    const tx = this.transactionsRepository.create({
      type: params.type,
      status: TransactionStatus.pending,
      vault_id: params.vaultId,
      chain_id: params.vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: params.vault.contract_address,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: params.expectedEvents,
    });
    return this.transactionsRepository.save(tx);
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private async validateAndCommit(
    snapshotId: string,
    adminTxId: string,
    vaultAddress: Address,
    vaultId: string,
    cycleId: bigint,
    result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>,
    expected: {
      expectedRoot: Hex;
      expectedValuationHash: Hex;
      expectedTotalVt: bigint;
      expectedTotalNative: bigint;
    }
  ): Promise<void> {
    const { expectedRoot, expectedValuationHash, expectedTotalVt, expectedTotalNative } = expected;

    const cycleClosed = result.decodedEvents.find(
      e => e.eventName === 'CycleClosed' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );

    if (!cycleClosed) {
      // Successful receipt, no matching event. Do NOT fail — kick to
      // reconciliation so we can check the on-chain cycle before deciding.
      await this.dataSource.transaction(async manager => {
        await manager.update(
          EvmValuationSnapshot,
          { id: snapshotId },
          {
            status: EvmSnapshotStatus.reconciliation_required,
            submit_tx_hash: result.hash,
            failure_reason: `CycleClosed event not found (or wrong emitter) in receipt for tx ${result.hash}`,
          }
        );
        // Confirm the tx status (it landed) but leave reconciliation_status='pending'.
        await manager.update(
          Transaction,
          { id: adminTxId },
          {
            status: TransactionStatus.confirmed,
            reconciliation_last_error: `CycleClosed event not found (or wrong emitter) in tx ${result.hash}`,
          }
        );
      });
      throw new Error(
        `CycleClosed event missing/mismatched-emitter in tx ${result.hash} — snapshot ${snapshotId} marked reconciliation_required`
      );
    }

    const args = cycleClosed.args as {
      cycleId: bigint;
      allocationRoot: Hex;
      valuationHash: Hex;
      totalVtAllocation: bigint;
      totalNativeAllocation: bigint;
    };

    const mismatches: string[] = [];
    if (args.cycleId !== cycleId) mismatches.push(`cycleId ${args.cycleId} vs ${cycleId}`);
    if (args.allocationRoot.toLowerCase() !== expectedRoot.toLowerCase())
      mismatches.push(`root ${args.allocationRoot} vs ${expectedRoot}`);
    if (args.valuationHash.toLowerCase() !== expectedValuationHash.toLowerCase())
      mismatches.push(`valuationHash ${args.valuationHash} vs ${expectedValuationHash}`);
    if (args.totalVtAllocation !== expectedTotalVt)
      mismatches.push(`totalVt ${args.totalVtAllocation} vs ${expectedTotalVt}`);
    if (args.totalNativeAllocation !== expectedTotalNative)
      mismatches.push(`totalNative ${args.totalNativeAllocation} vs ${expectedTotalNative}`);

    if (mismatches.length > 0) {
      await this.dataSource.transaction(async manager => {
        await manager.update(
          EvmValuationSnapshot,
          { id: snapshotId },
          {
            status: EvmSnapshotStatus.reconciliation_required,
            submit_tx_hash: result.hash,
            failure_reason: `CycleClosed mismatch(es): ${mismatches.join('; ')}`,
          }
        );
        await manager.update(
          Transaction,
          { id: adminTxId },
          {
            status: TransactionStatus.confirmed,
            reconciliation_last_error: `CycleClosed mismatch(es): ${mismatches.join('; ')}`,
          }
        );
      });
      throw new Error(
        `CycleClosed event mismatches for tx ${result.hash}: ${mismatches.join('; ')} — snapshot ${snapshotId} marked reconciliation_required`
      );
    }

    // All good — commit atomically.
    const snapshot = await this.snapshotsRepository.findOne({ where: { id: snapshotId } });
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} vanished before commit`);
    await this.commitConfirmed(snapshot, adminTxId, vaultId, cycleId, expectedRoot, result.hash);

    this.logger.log(`Cycle ${cycleId} for vault ${vaultId} confirmed. tx=${result.hash} root=${expectedRoot}`);
  }

  private async commitConfirmed(
    snapshot: EvmValuationSnapshot,
    adminTxId: string | null,
    vaultId: string,
    cycleId: bigint,
    root: Hex,
    txHash: Hex
  ): Promise<void> {
    await this.dataSource.transaction(async manager => {
      await manager.update(
        EvmValuationSnapshot,
        { id: snapshot.id },
        {
          status: EvmSnapshotStatus.confirmed,
          submit_tx_hash: txHash,
          confirmed_at: new Date(),
          failure_reason: null,
        }
      );
      await manager.update(
        Vault,
        { id: vaultId },
        {
          evm_current_cycle_id: cycleId.toString(),
          evm_allocation_root: root,
          evm_close_cycle_tx_hash: txHash,
          evm_root_committed_at: new Date(),
        }
      );
      if (adminTxId) {
        // Mark admin Tx confirmed, and if the receipt-time event validation
        // already covered our expected_events spec then reconciliation is
        // done. Set reconciled_at directly.
        await manager.update(
          Transaction,
          { id: adminTxId },
          {
            status: TransactionStatus.confirmed,
            reconciliation_status: EvmReconciliationStatus.success,
            reconciled_at: new Date(),
            reconciliation_last_error: null,
          }
        );
      }
    });
  }
}
