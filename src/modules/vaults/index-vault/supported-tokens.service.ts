import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Address, Hex } from 'viem';

import { IndexSwapRouteService } from './index-swap-route.service';
import type { ReplaceSupportedTokensReq, SupportedTokensRes } from './supported-tokens.types';

import { SupportedTokenRow } from '@/database/supported-token.entity';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { allowedPoolIds } from '@/modules/vaults/processing-tx/onchain/evm-swap-guard';

const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The public /supported-tokens list. Rows come from `swap-pool-review.ts` (admin PUT); every read
 * re-checks on chain that each token's pools are still allowlisted on the current swap adapter,
 * so a pool the Safe removes drops its token from the page within CACHE_TTL_MS, without a new review.
 */
@Injectable()
export class SupportedTokensService {
  private readonly logger = new Logger(SupportedTokensService.name);
  private readonly chainId: number;
  private cache: { at: number; value: Promise<SupportedTokensRes> } | null = null;

  constructor(
    @InjectRepository(SupportedTokenRow) private readonly repo: Repository<SupportedTokenRow>,
    private readonly routeService: IndexSwapRouteService,
    private readonly contractReader: EvmContractReader,
    configService: ConfigService
  ) {
    this.chainId = Number(configService.get<string>('EVM_CHAIN_ID') ?? 4663);
  }

  list(): Promise<SupportedTokensRes> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const value = this.load().catch(err => {
      this.cache = null;
      throw err;
    });
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Replaces the whole list of this chain (the review script always sends the full list). */
  async replace(req: ReplaceSupportedTokensReq): Promise<{ count: number }> {
    const rows = req.tokens.map(t =>
      this.repo.create({
        chainId: this.chainId,
        address: t.address.toLowerCase(),
        symbol: t.symbol,
        name: t.name,
        category: t.category,
        liquidity: t.liquidity,
        roundTripLossBps: t.roundTripLossBps ?? null,
        refEth: req.refEth,
        poolIds: t.poolIds.map(id => id.toLowerCase()),
        checkedAt: new Date(t.checkedAt),
      })
    );
    await this.repo.manager.transaction(async em => {
      await em.delete(SupportedTokenRow, { chainId: this.chainId });
      if (rows.length) await em.save(SupportedTokenRow, rows, { chunk: 200 });
    });
    this.cache = null;
    this.logger.log(`supported tokens replaced: ${rows.length} on chain ${this.chainId}`);
    return { count: rows.length };
  }

  private async load(): Promise<SupportedTokensRes> {
    const rows = await this.repo.find({ where: { chainId: this.chainId }, order: { symbol: 'ASC' } });
    let visible = rows;
    try {
      const adapter = this.routeService.tradingAdapterFor(null);
      const ids = rows.flatMap(r => r.poolIds) as Hex[];
      const allowed = ids.length
        ? await allowedPoolIds(this.contractReader.publicClient, adapter as Address, ids)
        : null;
      // null: adapter not guarded or allowlist unreadable; show the reviewed list as is.
      if (allowed) visible = rows.filter(r => r.poolIds.every(id => allowed.has(id.toLowerCase())));
      if (visible.length < rows.length) {
        this.logger.warn(
          `supported tokens: ${rows.length - visible.length} hidden, their pools are no longer allowlisted`
        );
      }
    } catch (err) {
      this.logger.warn(`supported tokens: on-chain check skipped (${(err as Error).message})`);
    }
    const updatedAt = rows.reduce<Date | null>((m, r) => (!m || r.checkedAt > m ? r.checkedAt : m), null);
    return {
      updatedAt: updatedAt?.toISOString() ?? null,
      refEth: rows[0]?.refEth ?? '0.1',
      tokens: visible.map(r => ({
        address: r.address,
        symbol: r.symbol,
        name: r.name,
        category: r.category,
        liquidity: r.liquidity,
        roundTripLossBps: r.roundTripLossBps,
        checkedAt: r.checkedAt.toISOString(),
      })),
    };
  }
}
