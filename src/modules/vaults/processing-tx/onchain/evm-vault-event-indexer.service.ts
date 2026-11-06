import { earliestEvmDeployBlock } from './evm-protocol-versions';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { IsNull, Not, Repository } from 'typeorm';
import type { Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';
import { EvmVaultEventReconciler, type VaultLogInput } from './evm-vault-event-reconciler.service';

import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';
import { ChainType } from '@/types/vault.types';

const MAX_RANGE = 200_000n;
const MIN_RANGE = 1_000n;
const ADDRESSES_PER_CALL = 100;
/** Re-scanned every tick so a log in a block reorged out of the last scan is not lost. */
const REORG_OVERLAP = 600n;
/** A vault first seen after the cursor passed its creation is scanned back this far (~1 day at 10 blocks/s). */
const NEW_VAULT_LOOKBACK = 900_000n;

/**
 * Indexes every event that Robinhood vault contracts emit, whoever sent the
 * transaction. The Alchemy webhook only watches the factory, and the receipt
 * paths only see transactions our app recorded, so without this a claim,
 * cancel or redeem sent from a block explorer, a script or another frontend
 * would never reach the DB.
 *
 * One cursor in Redis covers all vaults. The reconciler is idempotent, so the
 * overlap and the catch-up for newly seen vaults are safe to replay.
 */
@Injectable()
export class EvmVaultEventIndexerService {
  private readonly logger = new Logger(EvmVaultEventIndexerService.name);
  private readonly cursorKey: string;
  private readonly enabled: boolean;
  private knownVaults: Set<string> | null = null;
  private running = false;

  constructor(
    @InjectRepository(Vault) private readonly vaultsRepository: Repository<Vault>,
    private readonly contractReader: EvmContractReader,
    private readonly reconciler: EvmVaultEventReconciler,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly alerts: AlertsService
  ) {
    this.cursorKey = `evm:vault-event-indexer:${this.configService.get<string>('EVM_CHAIN_ID') || '46630'}:cursor`;
    this.enabled = this.configService.get<string>('EVM_VAULT_EVENT_INDEXER_ENABLED') !== 'false';
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.indexOnce();
    } catch (err) {
      this.logger.error(`Vault event indexing failed: ${(err as Error).message}`);
      void this.alerts.sendAlert('evm_event_indexer_failed', { chain: 'robinhood', error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async indexOnce(): Promise<void> {
    const vaults = await this.vaultsRepository.find({
      where: { chain_type: ChainType.robinhood, contract_address: Not(IsNull()) },
      select: ['id', 'contract_address'],
    });
    const addresses = vaults.map(v => v.contract_address!.toLowerCase() as Address);
    if (addresses.length === 0) return;

    const latest = await this.contractReader.publicClient.getBlockNumber();
    const stored = await this.redis.get(this.cursorKey);
    const cursor = stored ? BigInt(stored) : this.factoryDeployBlock();

    // Vaults that appeared since the last tick may have events behind the cursor.
    if (this.knownVaults && stored) {
      const fresh = addresses.filter(a => !this.knownVaults!.has(a));
      if (fresh.length > 0) {
        const from = cursor > NEW_VAULT_LOOKBACK ? cursor - NEW_VAULT_LOOKBACK : this.factoryDeployBlock();
        await this.scan(fresh, from, cursor);
      }
    }
    this.knownVaults = new Set(addresses);

    const from = cursor > REORG_OVERLAP ? cursor - REORG_OVERLAP : 0n;
    if (from > latest) return;
    const reached = await this.scan(addresses, from, latest);
    await this.redis.set(this.cursorKey, reached.toString());
  }

  /** Feeds every vault log in [from, to] to the reconciler. Returns the next block to scan. */
  private async scan(addresses: Address[], from: bigint, to: bigint): Promise<bigint> {
    let range = MAX_RANGE;
    let start = from;
    while (start <= to) {
      const end = start + range - 1n > to ? to : start + range - 1n;
      let logs: VaultLogInput[];
      try {
        logs = await this.fetchLogs(addresses, start, end);
      } catch (err) {
        if (range > MIN_RANGE) {
          range = range / 4n > MIN_RANGE ? range / 4n : MIN_RANGE;
          continue;
        }
        // Stop here; the next tick resumes from this block.
        this.logger.warn(`getLogs failed for blocks ${start}..${end}: ${(err as Error).message}`);
        return start;
      }

      if (logs.length > 0) {
        const stats = await this.reconciler.reconcileLogs(logs);
        if (stats.processed > 0 || stats.errors > 0) {
          this.logger.log(
            `Vault events ${start}..${end}: processed=${stats.processed} skipped=${stats.skipped} errors=${stats.errors}`
          );
        }
      }
      start = end + 1n;
    }
    return start;
  }

  private async fetchLogs(addresses: Address[], fromBlock: bigint, toBlock: bigint): Promise<VaultLogInput[]> {
    const out: VaultLogInput[] = [];
    for (let i = 0; i < addresses.length; i += ADDRESSES_PER_CALL) {
      const logs = await this.contractReader.publicClient.getLogs({
        address: addresses.slice(i, i + ADDRESSES_PER_CALL),
        fromBlock,
        toBlock,
      });
      for (const l of logs) {
        out.push({
          address: l.address,
          data: l.data ?? '0x',
          topics: (l.topics ?? []) as string[],
          txHash: l.transactionHash,
          blockNumber: l.blockNumber != null ? String(l.blockNumber) : null,
          logIndex: l.logIndex ?? null,
        });
      }
    }
    // Apply in chain order: a cancel must follow the contribution it cancels.
    return out.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : BigInt(a.blockNumber ?? 0) < BigInt(b.blockNumber ?? 0)
          ? -1
          : 1
    );
  }

  /** Vaults of every version are indexed, so a cold start begins at the earliest factory. */
  private factoryDeployBlock(): bigint {
    const earliest = earliestEvmDeployBlock(Number(this.configService.get<string>('EVM_CHAIN_ID')));
    if (earliest !== null) return earliest;
    const raw = this.configService.get<string>('EVM_FACTORY_DEPLOY_BLOCK')?.trim();
    return raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  }
}
