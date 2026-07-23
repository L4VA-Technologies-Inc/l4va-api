import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { VAULT_ABI } from './vault.abi';

import { EvmAllocation } from '@/database/evm-allocation.entity';
import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import {
  EvmReconciliationStatus,
  TransactionStatus,
  TransactionType,
} from '@/types/transaction.types';
import { ChainType } from '@/types/vault.types';

/**
 * Solidity `MAX_BATCH_SIZE = 20` (see `Vault.sol#L71`). Keeps `claimAllocations`
 * gas within a single tx and matches the contract's own revert boundary.
 */
const MAX_BATCH_SIZE = 20;

interface PickedAllocation {
  id: string;
  vault_id: string;
  cycle_id: string;
  claim_index: string;
  contributor: string;
  vt_amount: string;
  native_amount: string;
  proof: string[];
}

interface PushResult {
  batchesBroadcast: number;
  claimsBroadcast: number;
  alreadyClaimedSkipped: number;
  txHashes: Hex[];
}

/**
 * Batches unclaimed EvmAllocation rows into `claimAllocations(...)` calls
 * from the admin key. Runs after `EvmCycleCloseService` has committed a
 * `confirmed` snapshot (i.e. the on-chain cycle is `Locked` and the root
 * is fixed).
 *
 * Concurrency:
 *   - Within a process: `processingVaults` set prevents overlapping runs.
 *   - Across replicas: no DB reservation; we rely on `isClaimed()` RPC
 *     filtering PLUS the contract's `AllocationAlreadyClaimed` revert as
 *     the correctness bound.
 *
 * Every broadcast creates a `Transaction` row with
 *   type = evmClaim
 *   expected_events = [{ name: 'AllocationClaimed', count: N }]
 * so the health-check cron / webhook path can reconcile against the receipt.
 */
@Injectable()
export class EvmAirdropOrchestrator {
  private readonly logger = new Logger(EvmAirdropOrchestrator.name);
  private readonly processingVaults = new Set<string>();

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(EvmAllocation) private readonly allocationsRepository: Repository<EvmAllocation>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner
  ) {}

  // --------------------------------------------------------------------------
  // Cron entrypoint — find every vault with confirmed snapshots + unclaimed
  // allocations and push one batch per vault per tick.
  // --------------------------------------------------------------------------
  async pushAllVaults(): Promise<PushResult> {
    // Find (vault_id, cycle_id) pairs with confirmed snapshots that still have
    // unclaimed allocations.
    const eligible = await this.snapshotsRepository
      .createQueryBuilder('snap')
      .innerJoin(Vault, 'vault', 'vault.id = snap.vault_id')
      .innerJoin(
        EvmAllocation,
        'alloc',
        'alloc.vault_id = snap.vault_id AND alloc.cycle_id = snap.cycle_id AND alloc.claimed_at IS NULL'
      )
      .where('snap.status = :confirmed', { confirmed: EvmSnapshotStatus.confirmed })
      .andWhere('vault.chain_type = :evmChain', { evmChain: ChainType.robinhood })
      .andWhere('vault.contract_address IS NOT NULL')
      .select('snap.vault_id', 'vault_id')
      .addSelect('snap.cycle_id', 'cycle_id')
      .groupBy('snap.vault_id')
      .addGroupBy('snap.cycle_id')
      .getRawMany<{ vault_id: string; cycle_id: string }>();

    const totals: PushResult = { batchesBroadcast: 0, claimsBroadcast: 0, alreadyClaimedSkipped: 0, txHashes: [] };

    for (const { vault_id, cycle_id } of eligible) {
      if (this.processingVaults.has(vault_id)) continue;
      this.processingVaults.add(vault_id);
      try {
        const one = await this.pushOneBatchForVault(vault_id, BigInt(cycle_id));
        totals.batchesBroadcast += one.batchesBroadcast;
        totals.claimsBroadcast += one.claimsBroadcast;
        totals.alreadyClaimedSkipped += one.alreadyClaimedSkipped;
        totals.txHashes.push(...one.txHashes);
      } catch (err) {
        this.logger.error(`Airdrop batch failed for vault ${vault_id} cycle ${cycle_id}: ${(err as Error).message}`);
      } finally {
        this.processingVaults.delete(vault_id);
      }
    }
    return totals;
  }

  // --------------------------------------------------------------------------
  // Per-vault: push exactly ONE batch. Next cron tick picks up the remainder.
  // Callable directly from admin endpoints too.
  // --------------------------------------------------------------------------
  async pushOneBatchForVault(vaultId: string, cycleId: bigint): Promise<PushResult> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }

    // Snapshot must be confirmed — the root is only fixed then.
    const snapshot = await this.snapshotsRepository.findOne({
      where: { vault_id: vaultId, cycle_id: cycleId.toString() },
    });
    if (!snapshot) {
      throw new BadRequestException(`No snapshot for vault ${vaultId} cycle ${cycleId}`);
    }
    if (snapshot.status !== EvmSnapshotStatus.confirmed) {
      throw new BadRequestException(
        `Snapshot ${snapshot.id} is '${snapshot.status}' — must be 'confirmed' before pushing claims`
      );
    }

    // Pick candidate rows. Sort by claim_index for deterministic ordering.
    const candidates = (await this.allocationsRepository
      .createQueryBuilder('alloc')
      .where('alloc.vault_id = :vaultId', { vaultId })
      .andWhere('alloc.cycle_id = :cycleId', { cycleId: cycleId.toString() })
      .andWhere('alloc.claimed_at IS NULL')
      .orderBy('alloc.claim_index', 'ASC')
      .limit(MAX_BATCH_SIZE * 2) // over-fetch so we can skip already-on-chain-claimed
      .getMany()) as unknown as PickedAllocation[];

    if (candidates.length === 0) {
      return { batchesBroadcast: 0, claimsBroadcast: 0, alreadyClaimedSkipped: 0, txHashes: [] };
    }

    const vaultAddress = vault.contract_address as Address;

    // RPC-guard: filter out rows already claimed on-chain (webhook race /
    // third-party claimer / prior run that didn't get its receipt back).
    // Mark those reconciled locally without broadcasting anything.
    const batch: PickedAllocation[] = [];
    let alreadyClaimedSkipped = 0;
    for (const row of candidates) {
      const onChainClaimed = await this.contractReader.isClaimed(
        vaultAddress,
        cycleId,
        BigInt(row.claim_index)
      );
      if (onChainClaimed) {
        await this.allocationsRepository
          .createQueryBuilder()
          .update(EvmAllocation)
          .set({ claimed_at: () => 'CURRENT_TIMESTAMP' })
          .where('id = :id AND claimed_at IS NULL', { id: row.id })
          .execute();
        alreadyClaimedSkipped++;
        continue;
      }
      batch.push(row);
      if (batch.length >= MAX_BATCH_SIZE) break;
    }

    if (batch.length === 0) {
      return {
        batchesBroadcast: 0,
        claimsBroadcast: 0,
        alreadyClaimedSkipped,
        txHashes: [],
      };
    }

    // Build args for claimAllocations(AllocationClaim[]).
    // Solidity struct field order (VaultTypes.sol#AllocationClaim):
    //   cycleId, claimIndex, contributor, vtAmount, nativeAmount, proof.
    const args = [
      batch.map(r => ({
        cycleId,
        claimIndex: BigInt(r.claim_index),
        contributor: r.contributor as Address,
        vtAmount: BigInt(r.vt_amount),
        nativeAmount: BigInt(r.native_amount),
        proof: r.proof as Hex[],
      })),
    ];

    // Create admin Transaction row upfront so a crash between broadcast and
    // receipt is recoverable by the health-check cron.
    const adminTx = await this.createAdminClaimTxRow(vault, batch.length);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: vaultAddress,
          abi: VAULT_ABI,
          functionName: 'claimAllocations',
          args,
        },
        ['AllocationClaimed'],
        async (hash) => {
          await this.dataSource.transaction(async manager => {
            // Persist hash on the admin Tx row.
            await manager.update(
              Transaction,
              { id: adminTx.id },
              { tx_hash: hash, status: TransactionStatus.submitted }
            );
            // Tentatively pin each allocation to this tx hash so parallel
            // ticks / operators know the row is in flight. `claimed_at` is
            // still NULL — set only once the AllocationClaimed event is
            // reconciled by the reconciler / webhook / cron.
            await manager
              .createQueryBuilder()
              .update(EvmAllocation)
              .set({ claim_tx_hash: hash })
              .where('id IN (:...ids) AND claimed_at IS NULL', { ids: batch.map(b => b.id) })
              .execute();
          });
        }
      );
    } catch (err) {
      if (err instanceof TxRevertedError) {
        // Contract reverted — most likely `AllocationAlreadyClaimed` race, or
        // a stale root. Mark tx failed; release the tentative claim_tx_hash
        // pin so the next cron tick re-selects. Do NOT touch claimed_at.
        await this.dataSource.transaction(async manager => {
          await manager.update(
            Transaction,
            { id: adminTx.id },
            {
              status: TransactionStatus.failed,
              tx_hash: err.hash,
              reconciliation_status: EvmReconciliationStatus.failed,
              reconciliation_last_error: `claimAllocations reverted: ${err.message.slice(0, 500)}`,
            }
          );
          await manager
            .createQueryBuilder()
            .update(EvmAllocation)
            .set({ claim_tx_hash: null })
            .where('id IN (:...ids) AND claim_tx_hash = :hash AND claimed_at IS NULL', {
              ids: batch.map(b => b.id),
              hash: err.hash,
            })
            .execute();
        });
        throw err;
      }
      // Broadcast/receipt error with no on-chain revert — leave to health-check.
      const reason = (err as Error).message || String(err);
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${reason.slice(0, 500)}` }
      );
      throw err;
    }

    // Receipt succeeded — validate the exact event set matches this batch.
    await this.validateAndReconcile(adminTx.id, vaultAddress, batch, result);

    return {
      batchesBroadcast: 1,
      claimsBroadcast: batch.length,
      alreadyClaimedSkipped,
      txHashes: [result.hash],
    };
  }

  /**
   * Explicit retry entry point for a failed / manual-review claim batch.
   * The Transaction row is only reset; the actual retry happens on the next
   * cron tick via candidate selection (since the failed batch's rows still
   * have claim_tx_hash NULL after the revert unwind above).
   */
  async retryClaimBatch(txId: string): Promise<boolean> {
    const result = await this.transactionsRepository
      .createQueryBuilder()
      .update(Transaction)
      .set({
        reconciliation_status: EvmReconciliationStatus.pending,
        reconciliation_attempts: 0,
        reconciliation_last_error: null,
      })
      .where('id = :id AND type = :type AND reconciled_at IS NULL', {
        id: txId,
        type: TransactionType.evmClaim,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async createAdminClaimTxRow(vault: Vault, batchSize: number): Promise<Transaction> {
    const tx = this.transactionsRepository.create({
      type: TransactionType.evmClaim,
      status: TransactionStatus.pending,
      vault_id: vault.id,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vault.contract_address,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'AllocationClaimed', count: batchSize }],
    });
    return this.transactionsRepository.save(tx);
  }

  /**
   * Strict per-batch validation: every leaf we submitted must appear in the
   * receipt as an AllocationClaimed event emitted by our vault contract.
   * Mismatch → snapshot-agnostic; we mark the admin Tx confirmed but leave
   * reconciliation_status='pending' so the cron re-fetches and reconciles.
   */
  private async validateAndReconcile(
    adminTxId: string,
    vaultAddress: Address,
    batch: PickedAllocation[],
    result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>
  ): Promise<void> {
    const claimed = result.decodedEvents.filter(
      e => e.eventName === 'AllocationClaimed' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );
    // Cross-check every (cycleId, claimIndex, contributor, vt, native).
    const missing: string[] = [];
    for (const row of batch) {
      const match = claimed.find(evt => {
        const a = evt.args as {
          cycleId: bigint;
          claimIndex: bigint;
          contributor: Address;
          vtAmount: bigint;
          nativeAmount: bigint;
        };
        return (
          a.cycleId === BigInt(row.cycle_id) &&
          a.claimIndex === BigInt(row.claim_index) &&
          a.contributor.toLowerCase() === row.contributor.toLowerCase() &&
          a.vtAmount === BigInt(row.vt_amount) &&
          a.nativeAmount === BigInt(row.native_amount)
        );
      });
      if (!match) missing.push(`claimIndex=${row.claim_index}`);
    }

    if (missing.length > 0) {
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.confirmed,
          reconciliation_last_error: `AllocationClaimed events missing/mismatched for ${missing.join(', ')}`,
        }
      );
      throw new Error(
        `claimAllocations tx ${result.hash}: expected ${batch.length} matching AllocationClaimed events; missing ${missing.length}. Leaving reconciliation pending.`
      );
    }

    // Happy path — update every allocation row + the admin Tx atomically.
    await this.dataSource.transaction(async manager => {
      for (const row of batch) {
        await manager
          .createQueryBuilder()
          .update(EvmAllocation)
          .set({
            claimed_at: new Date(),
            claim_tx_hash: result.hash,
            claim_block_number:
              result.receipt.blockNumber != null ? String(result.receipt.blockNumber) : null,
          })
          .where('id = :id AND claimed_at IS NULL', { id: row.id })
          .execute();
      }
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
    });

    this.logger.log(
      `Airdrop batch confirmed: vault=${vaultAddress} count=${batch.length} tx=${result.hash} block=${result.receipt.blockNumber}`
    );
  }
}
