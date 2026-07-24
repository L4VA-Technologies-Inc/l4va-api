import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { getAbiItem, type Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { EvmVaultEventReconciler, type VaultLogInput } from './evm-vault-event-reconciler.service';
import { VAULT_ABI } from './vault.abi';

import { EvmContribution } from '@/database/evm-contribution.entity';
import { Vault } from '@/database/vault.entity';
import { ChainType, VaultStatus } from '@/types/vault.types';

/**
 * Poll-based backfill for `evm_contributions`.
 *
 * The webhook path (EvmWebhookService → EvmVaultEventReconciler) is the
 * fast path for turning `ContributionMade` events into DB rows. When it
 * misses an event (dropped webhook, ordering issues, Alchemy outage, tx
 * indexed before the vault was registered, etc.) the vault ends up with
 * on-chain contributions but no matching DB rows, which blocks the
 * lock-time snapshot builder.
 *
 * This service defends against that by periodically reading on-chain
 * state and comparing it against the DB:
 *   1. Read `totalContributions()` for each candidate vault.
 *   2. Count `evm_contributions` rows in the DB for the same vault.
 *   3. If counts match → skip.
 *   4. Otherwise → `getLogs(ContributionMade)` bounded by a configurable
 *      block lookback, and feed the logs into `reconcileLogs()`.
 *
 * The reconciler is idempotent (unique `(vault_id, on_chain_contribution_id)`),
 * so re-processing already-persisted contributions is a no-op.
 */
@Injectable()
export class EvmContributionBackfillService {
  private readonly logger = new Logger(EvmContributionBackfillService.name);
  private readonly processingVaults = new Set<string>();
  private readonly lookbackBlocks: bigint;
  private readonly maxRangePerCall: bigint;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(EvmContribution) private readonly contribsRepository: Repository<EvmContribution>,
    private readonly contractReader: EvmContractReader,
    private readonly reconciler: EvmVaultEventReconciler,
    configService: ConfigService
  ) {
    const raw = configService.get<string>('EVM_BACKFILL_LOOKBACK_BLOCKS');
    this.lookbackBlocks = raw ? BigInt(raw) : 500_000n;
    const rangeRaw = configService.get<string>('EVM_BACKFILL_MAX_RANGE');
    this.maxRangePerCall = rangeRaw ? BigInt(rangeRaw) : 10_000n;
  }

  /**
   * Sweep all EVM vaults in a pre-lock DB status and reconcile any missing
   * `evm_contributions` rows from on-chain state.
   */
  async sweepAllVaults(): Promise<void> {
    const candidates = await this.vaultsRepository
      .createQueryBuilder('vault')
      .where('vault.chain_type = :evmChain', { evmChain: ChainType.robinhood })
      .andWhere('vault.contract_address IS NOT NULL')
      .andWhere('vault.evm_root_committed_at IS NULL')
      .andWhere('vault.evm_cancel_cycle_tx_hash IS NULL')
      .andWhere('vault.vault_status IN (:...statuses)', {
        statuses: [VaultStatus.contribution, VaultStatus.acquire, VaultStatus.published],
      })
      .select(['vault.id', 'vault.contract_address'])
      .getMany();

    if (candidates.length === 0) return;

    for (const vault of candidates) {
      if (this.processingVaults.has(vault.id)) continue;
      this.processingVaults.add(vault.id);
      try {
        await this.backfillVault(vault.id);
      } catch (err) {
        this.logger.warn(`Backfill failed for vault ${vault.id}: ${(err as Error).message}`);
      } finally {
        this.processingVaults.delete(vault.id);
      }
    }
  }

  /**
   * Reconcile missing rows for a single vault. Safe to call manually via
   * an admin endpoint — the reconciler ensures idempotency.
   */
  async backfillVault(vaultId: string): Promise<{ onChain: number; inDb: number; inserted: number }> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'contract_address', 'chain_type'],
    });
    if (!vault) {
      this.logger.debug(`backfillVault: vault ${vaultId} not found`);
      return { onChain: 0, inDb: 0, inserted: 0 };
    }
    if (vault.chain_type !== ChainType.robinhood || !vault.contract_address) {
      return { onChain: 0, inDb: 0, inserted: 0 };
    }

    const address = vault.contract_address as Address;

    // 1. On-chain count of contributions ever made against this vault.
    let onChain: bigint;
    try {
      onChain = await this.contractReader.totalContributions(address);
    } catch (err) {
      this.logger.debug(
        `backfillVault: totalContributions read failed for vault ${vault.id} (${address}): ${(err as Error).message}`
      );
      return { onChain: 0, inDb: 0, inserted: 0 };
    }

    if (onChain === 0n) return { onChain: 0, inDb: 0, inserted: 0 };

    // 2. DB row count.
    const inDb = await this.contribsRepository.count({ where: { vault_id: vault.id } });

    if (BigInt(inDb) >= onChain) {
      return { onChain: Number(onChain), inDb, inserted: 0 };
    }

    // 3. Fetch ContributionMade logs from a bounded range.
    const logs = await this.fetchContributionLogs(address);
    if (logs.length === 0) {
      return { onChain: Number(onChain), inDb, inserted: 0 };
    }

    // 4. Skip logs whose contribution_id we already have (fast path — reconciler
    //    would treat them as idempotent no-ops, but this reduces its work).
    const existingIds = new Set(
      (
        await this.contribsRepository.find({
          where: { vault_id: vault.id },
          select: ['on_chain_contribution_id'],
        })
      ).map(r => r.on_chain_contribution_id)
    );
    const missing = logs.filter(l => !existingIds.has(this.decodeContributionIdFromTopic(l.topics[1])));

    if (missing.length === 0) {
      return { onChain: Number(onChain), inDb, inserted: 0 };
    }

    // 5. Feed the missing logs to the reconciler.
    const stats = await this.reconciler.reconcileLogs(missing);

    // Count actual DB inserts vs "processed but skipped" (e.g. no-parent-Tx
    // third-party contributions that the reconciler silently ignores). Re-read
    // the DB to see the true delta.
    const inDbAfter = await this.contribsRepository.count({ where: { vault_id: vault.id } });
    const inserted = Math.max(0, inDbAfter - inDb);
    const skipped = Math.max(0, stats.processed - inserted) + stats.skipped;
    if (inserted > 0 || stats.errors > 0) {
      this.logger.log(
        `EVM contribution backfill: vault=${vault.id} inserted=${inserted} skipped=${skipped} errors=${stats.errors}`
      );
    } else {
      this.logger.debug(
        `EVM contribution backfill: vault=${vault.id} onChain=${onChain} inDb=${inDbAfter} — no new rows (skipped=${skipped})`
      );
    }

    return { onChain: Number(onChain), inDb: inDbAfter, inserted };
  }

  /**
   * Fetch `ContributionMade` logs for a vault in `maxRangePerCall`-sized
   * chunks over the last `lookbackBlocks`. Returned in ascending block order.
   */
  private async fetchContributionLogs(vault: Address): Promise<VaultLogInput[]> {
    const client = this.contractReader.publicClient;
    const abiEvent = getAbiItem({ abi: VAULT_ABI, name: 'ContributionMade' });
    const latest: bigint = await client.getBlockNumber();
    const from = latest > this.lookbackBlocks ? latest - this.lookbackBlocks : 0n;

    const collected: VaultLogInput[] = [];
    let cursor = from;
    while (cursor <= latest) {
      const chunkEnd = cursor + this.maxRangePerCall - 1n > latest ? latest : cursor + this.maxRangePerCall - 1n;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkLogs: any[] = await client.getLogs({
          address: vault,
          event: abiEvent,
          fromBlock: cursor,
          toBlock: chunkEnd,
        });
        for (const l of chunkLogs) {
          collected.push({
            address: l.address,
            data: l.data ?? '0x',
            topics: l.topics ?? [],
            txHash: l.transactionHash,
            blockNumber: l.blockNumber != null ? String(l.blockNumber) : null,
            logIndex: l.logIndex ?? null,
          });
        }
      } catch (err) {
        this.logger.warn(`getLogs failed for vault ${vault} blocks ${cursor}..${chunkEnd}: ${(err as Error).message}`);
      }
      cursor = chunkEnd + 1n;
    }
    return collected;
  }

  /** Extract the indexed `contributionId` from a `ContributionMade` topic. */
  private decodeContributionIdFromTopic(topic: string | undefined): string {
    if (!topic) return '';
    // topics are 32-byte hex. BigInt handles the leading zeros.
    try {
      return BigInt(topic).toString();
    } catch {
      return '';
    }
  }

  /**
   * Batch-friendly helper for callers that already have a vault entity in
   * hand and want to check just that vault. Wraps `backfillVault` with
   * the in-flight guard used by the cron sweep.
   */
  async backfillOne(vault: Pick<Vault, 'id'>): Promise<void> {
    if (this.processingVaults.has(vault.id)) return;
    this.processingVaults.add(vault.id);
    try {
      await this.backfillVault(vault.id);
    } finally {
      this.processingVaults.delete(vault.id);
    }
  }

  /** Bulk lookup used by admin-facing endpoints. */
  async listVaultsWithGaps(): Promise<Array<{ vaultId: string; onChain: number; inDb: number }>> {
    const evmVaults = await this.vaultsRepository.find({
      where: { chain_type: ChainType.robinhood, vault_status: In([VaultStatus.contribution, VaultStatus.acquire]) },
      select: ['id', 'contract_address'],
    });
    const result: Array<{ vaultId: string; onChain: number; inDb: number }> = [];
    for (const v of evmVaults) {
      if (!v.contract_address) continue;
      try {
        const onChain = await this.contractReader.totalContributions(v.contract_address as Address);
        const inDb = await this.contribsRepository.count({ where: { vault_id: v.id } });
        if (BigInt(inDb) < onChain) {
          result.push({ vaultId: v.id, onChain: Number(onChain), inDb });
        }
      } catch {
        /* ignore per-vault RPC errors */
      }
    }
    return result;
  }
}
