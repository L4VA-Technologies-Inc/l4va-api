import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { type Address, type Hex } from 'viem';

import { EvmAdminSigner, TxRevertedError } from './evm-admin-signer.service';
import { EvmContractReader } from './evm-contract-reader.service';
import { EvmCycleCloseService } from './evm-cycle-close.service';
import { EvmContributionStatus, EvmCycleStatus, VAULT_ABI } from './vault.abi';

import { EvmContribution, EvmContributionRowStatus } from '@/database/evm-contribution.entity';
import { EvmSnapshotStatus, EvmValuationSnapshot } from '@/database/evm-valuation-snapshot.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { EvmReconciliationStatus, TransactionStatus, TransactionType } from '@/types/transaction.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

/** Solidity `MAX_BATCH_SIZE = 20` (Vault.sol#L71). */
const MAX_BATCH_SIZE = 20;

interface PickedContribution {
  id: string;
  vault_id: string;
  cycle_id: string;
  on_chain_contribution_id: string;
  contributor: string;
}

export interface CancelSweepResult {
  vaultsChecked: number;
  cancellationsInitiated: number;
  cancellationsFailed: number;
}

export interface RefundBatchResult {
  batchesBroadcast: number;
  refundsBroadcast: number;
  alreadyRefundedSkipped: number;
  txHashes: Hex[];
}

/**
 * Failed-vault + refund pipeline.
 *
 * Two responsibilities:
 *   1. Detect EVM vaults whose acquire window has expired without meeting the
 *      cycle's `minAcquireThreshold` and trigger `cancelCurrentCycle()`.
 *   2. Batch out `refundContributions([...])` for every still-active
 *      EvmContribution row on a cancelled cycle.
 *
 * Both duties are cron-driven and gated by `EVM_CYCLE_AUTOMATION_ENABLED`
 * upstream. Contract-level dedup (`AllocationOverCommitted` /
 * `ContributionNotActive`) is the correctness bound for concurrent replicas.
 */
@Injectable()
export class EvmRefundOrchestrator {
  private readonly logger = new Logger(EvmRefundOrchestrator.name);
  private readonly processingVaults = new Set<string>();
  private readonly factoryAddress?: string;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmContribution) private readonly contribsRepository: Repository<EvmContribution>,
    @InjectRepository(EvmValuationSnapshot) private readonly snapshotsRepository: Repository<EvmValuationSnapshot>,
    @InjectRepository(Transaction) private readonly transactionsRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
    private readonly contractReader: EvmContractReader,
    private readonly adminSigner: EvmAdminSigner,
    private readonly cycleCloseService: EvmCycleCloseService,
    configService: ConfigService
  ) {
    // Cache the factory address so we can exclude vaults whose contract_address
    // is accidentally the factory (an early-flow bug leaves some rows in this
    // state; the factory does not implement currentCycleId / getCycle).
    const raw = configService.get<string>('EVM_FACTORY_ADDRESS');
    this.factoryAddress = raw ? raw.toLowerCase() : undefined;
  }

  // ==========================================================================
  // Failed-vault detection: cancelCurrentCycle when threshold missed.
  // ==========================================================================
  async detectAndCancelFailedVaults(): Promise<CancelSweepResult> {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const result: CancelSweepResult = { vaultsChecked: 0, cancellationsInitiated: 0, cancellationsFailed: 0 };

    // Candidate vaults: EVM, in acquire/contribution phase, no cancel tx yet,
    // no confirmed snapshot (i.e. we haven't just locked them).
    const query = this.vaultsRepository
      .createQueryBuilder('vault')
      .where('vault.chain_type = :evmChain', { evmChain: ChainType.robinhood })
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.evm_cancel_cycle_tx_hash IS NULL')
      .andWhere('vault.evm_root_committed_at IS NULL')
      .andWhere('vault.vault_status IN (:...statuses)', {
        statuses: [VaultStatus.acquire, VaultStatus.contribution, VaultStatus.published],
      });

    // Exclude vaults whose contract_address is the factory (bookkeeping bug
    // in early creation flow). Otherwise every tick will retry currentCycleId
    // against the factory and log noise.
    if (this.factoryAddress) {
      query.andWhere('LOWER(vault.contract_address) <> :factoryAddr', {
        factoryAddr: this.factoryAddress,
      });
    }

    const candidates = await query.getMany();

    for (const vault of candidates) {
      if (this.processingVaults.has(vault.id)) continue;
      result.vaultsChecked++;

      let onChainCycleId: bigint;
      let cycleView: Awaited<ReturnType<EvmContractReader['getCycle']>>;
      try {
        onChainCycleId = await this.contractReader.currentCycleId(vault.contract_address as Address);
        cycleView = await this.contractReader.getCycle(vault.contract_address as Address, onChainCycleId);
      } catch (err) {
        this.logger.warn(`detectFailedVaults: read failed for vault ${vault.id}: ${(err as Error).message}`);
        continue;
      }

      // Only Active cycles are cancellable via cancelCurrentCycle.
      if (cycleView.status !== EvmCycleStatus.Active) continue;

      // Acquire window must have ended.
      const acquireEnded = cycleView.acquireWindow.end === 0n || cycleView.acquireWindow.end <= nowSec;
      if (!acquireEnded) continue;

      // Threshold check: only cancel when a non-zero threshold is set AND
      // nativeCollected is below it. Vaults with a zero threshold never fail
      // via this path — they succeed at closeCycle time.
      if (cycleView.minAcquireThreshold === 0n) continue;
      if (cycleView.nativeCollected >= cycleView.minAcquireThreshold) continue;

      // Guard: don't cancel while a `ready` snapshot is being broadcast — the
      // closeCycle path owns the transition.
      const readySnap = await this.snapshotsRepository.findOne({
        where: {
          vault_id: vault.id,
          cycle_id: onChainCycleId.toString(),
          status: In([EvmSnapshotStatus.ready, EvmSnapshotStatus.submitting, EvmSnapshotStatus.submitted]),
        },
      });
      if (readySnap) continue;

      this.processingVaults.add(vault.id);
      try {
        this.logger.warn(
          `Vault ${vault.id} cycle ${onChainCycleId}: nativeCollected=${cycleView.nativeCollected} < ` +
            `minAcquireThreshold=${cycleView.minAcquireThreshold}, cancelling`
        );
        await this.cycleCloseService.cancelCurrentCycle(
          vault.id,
          `Acquire threshold not met: collected=${cycleView.nativeCollected} threshold=${cycleView.minAcquireThreshold}`
        );
        result.cancellationsInitiated++;
      } catch (err) {
        result.cancellationsFailed++;
        this.logger.error(`cancelCurrentCycle failed for vault ${vault.id}: ${(err as Error).message}`);
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }

    return result;
  }

  // ==========================================================================
  // Refund fan-out — push ONE batch per vault per tick.
  // ==========================================================================
  async pushAllVaults(): Promise<RefundBatchResult> {
    const totals: RefundBatchResult = {
      batchesBroadcast: 0,
      refundsBroadcast: 0,
      alreadyRefundedSkipped: 0,
      txHashes: [],
    };

    // Find vaults with a cancel tx recorded and at least one still-active
    // EvmContribution row. cycle_id comes from the contribution rows so we
    // handle vaults with multiple cancelled cycles gracefully.
    const eligible = await this.contribsRepository
      .createQueryBuilder('c')
      .innerJoin(Vault, 'vault', 'vault.id = c.vault_id')
      .where('c.status = :active', { active: EvmContributionRowStatus.active })
      .andWhere('vault.chain_type = :evmChain', { evmChain: ChainType.robinhood })
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.evm_cancel_cycle_tx_hash IS NOT NULL')
      .select('c.vault_id', 'vault_id')
      .addSelect('c.cycle_id', 'cycle_id')
      .groupBy('c.vault_id')
      .addGroupBy('c.cycle_id')
      .getRawMany<{ vault_id: string; cycle_id: string }>();

    for (const { vault_id, cycle_id } of eligible) {
      if (this.processingVaults.has(vault_id)) continue;
      this.processingVaults.add(vault_id);
      try {
        const one = await this.pushOneBatchForVault(vault_id, BigInt(cycle_id));
        totals.batchesBroadcast += one.batchesBroadcast;
        totals.refundsBroadcast += one.refundsBroadcast;
        totals.alreadyRefundedSkipped += one.alreadyRefundedSkipped;
        totals.txHashes.push(...one.txHashes);
      } catch (err) {
        this.logger.error(`Refund batch failed for vault ${vault_id} cycle ${cycle_id}: ${(err as Error).message}`);
      } finally {
        this.processingVaults.delete(vault_id);
      }
    }
    return totals;
  }

  async pushOneBatchForVault(vaultId: string, cycleId: bigint): Promise<RefundBatchResult> {
    const vault = await this.vaultsRepository.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.chain_type !== ChainType.robinhood) {
      throw new BadRequestException(`Vault ${vaultId} is not an EVM vault`);
    }
    if (!vault.contract_address) {
      throw new BadRequestException(`Vault ${vaultId} has no contract address`);
    }
    if (!vault.evm_cancel_cycle_tx_hash) {
      throw new BadRequestException(
        `Vault ${vaultId} cycle ${cycleId} has no cancel tx recorded — refund pipeline not applicable`
      );
    }

    const vaultAddress = vault.contract_address as Address;

    // Preflight: on-chain cycle must actually be Cancelled. Prevents pushing
    // refunds against a cycle that our DB thinks is cancelled but isn't
    // (e.g. cancel tx not yet mined; caught up by webhook reconciler).
    let cycleView: Awaited<ReturnType<EvmContractReader['getCycle']>>;
    try {
      cycleView = await this.contractReader.getCycle(vaultAddress, cycleId);
    } catch (err) {
      throw new Error(`getCycle failed for vault ${vaultId} cycle ${cycleId}: ${(err as Error).message}`);
    }
    if (cycleView.status !== EvmCycleStatus.Cancelled) {
      throw new BadRequestException(
        `Cycle ${cycleId} on-chain status is ${EvmCycleStatus[cycleView.status]}, not Cancelled`
      );
    }

    // Candidate rows.
    const candidates = (await this.contribsRepository
      .createQueryBuilder('c')
      .where('c.vault_id = :vaultId', { vaultId })
      .andWhere('c.cycle_id = :cycleId', { cycleId: cycleId.toString() })
      .andWhere('c.status = :active', { active: EvmContributionRowStatus.active })
      .orderBy('c.on_chain_contribution_id', 'ASC')
      .limit(MAX_BATCH_SIZE * 2)
      .getMany()) as unknown as PickedContribution[];

    if (candidates.length === 0) {
      return { batchesBroadcast: 0, refundsBroadcast: 0, alreadyRefundedSkipped: 0, txHashes: [] };
    }

    // RPC-guard: skip contributions already cancelled on-chain (webhook race
    // or prior run). Mark them refunded locally without broadcasting.
    const batch: PickedContribution[] = [];
    let alreadyRefundedSkipped = 0;
    for (const row of candidates) {
      let stillActive = false;
      try {
        const c = await this.contractReader.getContribution(vaultAddress, BigInt(row.on_chain_contribution_id));
        stillActive = c.status === EvmContributionStatus.Active;
      } catch (err) {
        this.logger.warn(
          `getContribution(${row.on_chain_contribution_id}) failed for vault ${vaultId}: ${(err as Error).message}. ` +
            `Assuming still active for retry.`
        );
        stillActive = true;
      }
      if (!stillActive) {
        await this.contribsRepository
          .createQueryBuilder()
          .update(EvmContribution)
          .set({
            status: EvmContributionRowStatus.refunded,
            refunded_at: () => 'CURRENT_TIMESTAMP',
          })
          .where('id = :id AND status = :expected', {
            id: row.id,
            expected: EvmContributionRowStatus.active,
          })
          .execute();
        alreadyRefundedSkipped++;
        continue;
      }
      batch.push(row);
      if (batch.length >= MAX_BATCH_SIZE) break;
    }

    if (batch.length === 0) {
      return {
        batchesBroadcast: 0,
        refundsBroadcast: 0,
        alreadyRefundedSkipped,
        txHashes: [],
      };
    }

    // Build args: refundContributions(uint256[] contributionIds).
    const args = [batch.map(r => BigInt(r.on_chain_contribution_id))];

    // Admin Transaction row with expected events for the health-check cron.
    const adminTx = await this.createAdminRefundTxRow(vault, batch.length);

    let result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>;
    try {
      result = await this.adminSigner.sendAndConfirm(
        {
          address: vaultAddress,
          abi: VAULT_ABI,
          functionName: 'refundContributions',
          args,
        },
        ['ContributionCancelled'],
        async hash => {
          await this.dataSource.transaction(async manager => {
            await manager.update(
              Transaction,
              { id: adminTx.id },
              { tx_hash: hash, status: TransactionStatus.submitted }
            );
            // Tentatively pin refund_tx_hash to this batch's hash. The row is
            // NOT marked refunded yet — that happens on ContributionCancelled
            // reconciliation.
            await manager
              .createQueryBuilder()
              .update(EvmContribution)
              .set({ refund_tx_hash: hash })
              .where('id IN (:...ids) AND status = :active', {
                ids: batch.map(b => b.id),
                active: EvmContributionRowStatus.active,
              })
              .execute();
          });
        }
      );
    } catch (err) {
      if (err instanceof TxRevertedError) {
        await this.dataSource.transaction(async manager => {
          await manager.update(
            Transaction,
            { id: adminTx.id },
            {
              status: TransactionStatus.failed,
              tx_hash: err.hash,
              reconciliation_status: EvmReconciliationStatus.failed,
              reconciliation_last_error: `refundContributions reverted: ${err.message.slice(0, 500)}`,
            }
          );
          // Release the tentative pin so next tick re-selects.
          await manager
            .createQueryBuilder()
            .update(EvmContribution)
            .set({ refund_tx_hash: null })
            .where('id IN (:...ids) AND status = :active AND refund_tx_hash = :hash', {
              ids: batch.map(b => b.id),
              active: EvmContributionRowStatus.active,
              hash: err.hash,
            })
            .execute();
        });
        throw err;
      }
      const reason = (err as Error).message || String(err);
      await this.transactionsRepository.update(
        { id: adminTx.id },
        { reconciliation_last_error: `broadcast/receipt: ${reason.slice(0, 500)}` }
      );
      throw err;
    }

    await this.validateAndReconcile(adminTx.id, vaultAddress, batch, result);

    return {
      batchesBroadcast: 1,
      refundsBroadcast: batch.length,
      alreadyRefundedSkipped,
      txHashes: [result.hash],
    };
  }

  /** Admin-triggered retry for a failed / manual-review refund batch. */
  async retryRefundBatch(txId: string): Promise<boolean> {
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
        type: TransactionType.evmRefund,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async createAdminRefundTxRow(vault: Vault, batchSize: number): Promise<Transaction> {
    const tx = this.transactionsRepository.create({
      type: TransactionType.evmRefund,
      status: TransactionStatus.pending,
      vault_id: vault.id,
      chain_id: vault.chain_id,
      from_address: this.adminSigner.address,
      to_address: vault.contract_address,
      reconciliation_status: EvmReconciliationStatus.pending,
      reconciliation_attempts: 0,
      expected_events: [{ name: 'ContributionCancelled', count: batchSize }],
    });
    return this.transactionsRepository.save(tx);
  }

  private async validateAndReconcile(
    adminTxId: string,
    vaultAddress: Address,
    batch: PickedContribution[],
    result: Awaited<ReturnType<EvmAdminSigner['sendAndConfirm']>>
  ): Promise<void> {
    const cancelled = result.decodedEvents.filter(
      e => e.eventName === 'ContributionCancelled' && e.address.toLowerCase() === vaultAddress.toLowerCase()
    );

    const missing: string[] = [];
    for (const row of batch) {
      const match = cancelled.find(evt => {
        const a = evt.args as { contributionId: bigint; contributor: Address };
        return (
          a.contributionId === BigInt(row.on_chain_contribution_id) &&
          a.contributor.toLowerCase() === row.contributor.toLowerCase()
        );
      });
      if (!match) missing.push(`contributionId=${row.on_chain_contribution_id}`);
    }

    if (missing.length > 0) {
      // Leave reconciliation pending so the health-check cron re-fetches the
      // canonical receipt and reconciles.
      await this.transactionsRepository.update(
        { id: adminTxId },
        {
          status: TransactionStatus.confirmed,
          reconciliation_last_error: `ContributionCancelled events missing/mismatched for ${missing.join(', ')}`,
        }
      );
      throw new Error(
        `refundContributions tx ${result.hash}: expected ${batch.length} ContributionCancelled events; ` +
          `missing ${missing.length}. Leaving reconciliation pending.`
      );
    }

    // Happy path — flip rows atomically. The reconciler's own
    // handleContributionCancelled will also do this idempotently when the
    // event flows through the webhook path, so races are safe.
    await this.dataSource.transaction(async manager => {
      for (const row of batch) {
        await manager
          .createQueryBuilder()
          .update(EvmContribution)
          .set({
            status: EvmContributionRowStatus.refunded,
            refund_tx_hash: result.hash,
            refunded_at: new Date(),
          })
          .where('id = :id AND status = :active', {
            id: row.id,
            active: EvmContributionRowStatus.active,
          })
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
      `Refund batch confirmed: vault=${vaultAddress} count=${batch.length} tx=${result.hash} block=${result.receipt.blockNumber}`
    );
  }
}
