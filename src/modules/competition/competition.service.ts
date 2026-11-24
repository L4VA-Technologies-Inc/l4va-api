import { Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';

import {
  CompetitionEntry,
  CompetitionEntryStatus,
  CompetitionSeason,
  CompetitionSnapshot,
} from '@/database/competition.entity';
import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { PriceService } from '@/modules/price/price.service';
import { EvmLiquidityService } from '@/modules/vaults/processing-tx/onchain/evm-liquidity.service';
import { EvmLpStatus } from '@/modules/vaults/processing-tx/onchain/evm-lp.config';
import { ChainType, VAULT_STATUSES_WITH_POTENTIAL_LP, VaultStatus } from '@/types/vault.types';

/** Qualifying return is the average price over this window after entry vs the entry price. */
const QUALIFYING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type LeaderboardStatus = 'qualifying' | 'qualified' | 'review';

export interface LeaderboardRow {
  vaultId: string;
  symbol: string | null;
  name: string;
  creator: string | null;
  imageUrl: string | null;
  enteredAt: Date;
  status: LeaderboardStatus;
  /** Percent. Provisional (window average so far) while `status === 'qualifying'`. */
  qualifyingReturn: number;
  totalReturn: number;
  /** NAV return, used by the Portfolios tab. */
  qualifyingValueReturn: number;
  totalValueReturn: number;
  priceUsd: number;
  value: number;
  liquidityUsd: number;
  holders: number | null;
}

export interface LeaderboardResponse {
  season: {
    slug: string;
    title: string;
    start: Date;
    entryCutoff: Date;
    promoEnd: Date | null;
    end: Date;
  };
  updatedAt: Date | null;
  tokens: LeaderboardRow[];
  portfolios: LeaderboardRow[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pctChange = (from: number, to: number): number => (from > 0 ? +(((to - from) / from) * 100).toFixed(2) : 0);

/**
 * Creator Challenge v0.1. Every hour, every Robinhood vault with a live pool
 * (including vaults created before the season) is entered while entries are
 * open and snapshotted until the season ends. Everything is read from source, nothing derived from other
 * crons: token price and liquidity from the vault's own pool (on-chain),
 * NAV from the vault, holders from Blockscout. The leaderboard is computed
 * from those snapshots on read.
 */
@Injectable()
export class CompetitionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompetitionService.name);

  constructor(
    @InjectRepository(CompetitionSeason) private readonly seasonRepo: Repository<CompetitionSeason>,
    @InjectRepository(CompetitionEntry) private readonly entryRepo: Repository<CompetitionEntry>,
    @InjectRepository(CompetitionSnapshot) private readonly snapshotRepo: Repository<CompetitionSnapshot>,
    @InjectRepository(Vault) private readonly vaultRepo: Repository<Vault>,
    @InjectRepository(Market) private readonly marketRepo: Repository<Market>,
    private readonly priceService: PriceService,
    private readonly liquidityService: EvmLiquidityService,
    private readonly configService: ConfigService
  ) {}

  /** Take a snapshot on boot when the last one is older than the cron period, so a restart never leaves a gap. */
  onApplicationBootstrap(): void {
    void (async (): Promise<void> => {
      const last = await this.snapshotRepo.findOne({ where: {}, order: { taken_at: 'DESC' } });
      if (last && Date.now() - new Date(last.taken_at).getTime() < 55 * 60 * 1000) return;
      await this.takeSnapshots();
    })().catch(error => this.logger.error(`Competition boot snapshot failed: ${(error as Error).message}`));
  }

  private blockscoutBase(): { url: string; apiKey: string | null } {
    const isMainnet = this.configService.get<string>('EVM_CHAIN_ID') === '4663';
    if (!isMainnet) return { url: 'https://explorer.testnet.chain.robinhood.com/api/v2', apiKey: null };
    const apiKey = this.configService.get<string>('BLOCKSCOUT_API_KEY')?.trim() || null;
    return apiKey
      ? { url: 'https://api.blockscout.com/4663/api/v2', apiKey }
      : { url: 'https://robinhoodchain.blockscout.com/api/v2', apiKey: null };
  }

  private async fetchHolders(token: string): Promise<number | null> {
    try {
      const { url, apiKey } = this.blockscoutBase();
      const target = new URL(`${url}/tokens/${token}`);
      if (apiKey) target.searchParams.set('apikey', apiKey);
      const response = await fetch(target, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { holders_count?: string | null; holders?: string | null };
      const holders = Number(body.holders_count ?? body.holders);
      return Number.isFinite(holders) ? holders : null;
    } catch {
      return null;
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledSnapshot(): Promise<void> {
    try {
      await this.takeSnapshots();
    } catch (error) {
      this.logger.error(`Competition snapshot failed: ${(error as Error).message}`);
    }
  }

  async takeSnapshots(now = new Date()): Promise<void> {
    const seasons = await this.seasonRepo
      .createQueryBuilder('s')
      .where('s.start_at <= :now AND s.end_at >= :now', { now })
      .getMany();
    if (seasons.length === 0) {
      this.logger.log('Competition: no active season');
      return;
    }

    const ethUsd = await this.priceService.getEthPrice();
    if (!(ethUsd > 0)) {
      this.logger.warn('Competition snapshot skipped: no ETH price');
      return;
    }

    for (const season of seasons) {
      const vaults = await this.vaultRepo
        .createQueryBuilder('v')
        .select(['v.id', 'v.ft_token_supply', 'v.total_assets_cost_usd'])
        .where('v.chain_type = :chain', { chain: ChainType.robinhood })
        .andWhere('v.has_active_lp = true')
        .andWhere('v.vault_status IN (:...statuses)', { statuses: VAULT_STATUSES_WITH_POTENTIAL_LP })
        // Vaults created before the season count too: their baseline is the first
        // snapshot inside the season, not their launch price.
        .getMany();
      this.logger.log(`Competition ${season.slug}: ${vaults.length} eligible vaults`);
      if (vaults.length === 0) continue;

      const entries = await this.entryRepo.find({ where: { season_id: season.id } });
      const entered = new Set(entries.map(e => e.vault_id));

      const entryOpen = now <= new Date(season.entry_cutoff_at);

      let taken = 0;
      for (const vault of vaults) {
        // After the cutoff, keep snapshotting entered vaults but admit no new ones.
        if (!entryOpen && !entered.has(vault.id)) continue;
        let lp: Awaited<ReturnType<EvmLiquidityService['getVaultLp']>>;
        try {
          lp = await this.liquidityService.getVaultLp(vault.id);
        } catch (error) {
          this.logger.warn(`Competition: pool read failed for ${vault.id}: ${(error as Error).message}`);
          continue;
        }
        const priceUsd = num(lp?.vtPriceNative) * ethUsd;
        if (lp?.status !== EvmLpStatus.provided || !(priceUsd > 0)) {
          this.logger.warn(
            `Competition ${season.slug}: skip ${vault.id} (lp=${lp?.status ?? 'none'}, price=${lp?.vtPriceNative ?? 'none'})`
          );
          continue;
        }
        const valueUsd = num(vault.total_assets_cost_usd);
        const holders = lp.vaultToken ? await this.fetchHolders(lp.vaultToken) : null;
        if (holders != null) {
          // Keep the Tokens table's holder count fresh too.
          await this.marketRepo.update({ vault_id: vault.id }, { holders_count: holders });
        }

        if (!entered.has(vault.id)) {
          await this.entryRepo.save(
            this.entryRepo.create({
              season_id: season.id,
              vault_id: vault.id,
              entered_at: now,
              entry_price_usd: String(priceUsd),
              entry_price_native: String(lp.vtPriceNative),
              entry_value_usd: String(valueUsd),
            })
          );
        }

        await this.snapshotRepo.save(
          this.snapshotRepo.create({
            season_id: season.id,
            vault_id: vault.id,
            taken_at: now,
            price_usd: String(priceUsd),
            price_native: String(lp.vtPriceNative),
            value_usd: String(valueUsd),
            fdv_usd: String(priceUsd * num(vault.ft_token_supply)),
            // Both sides of the pool, valued at the pool price.
            liquidity_usd: String(num(lp.reserveNative) * 2 * ethUsd),
            holders,
          })
        );
        taken++;
      }
      this.logger.log(`Competition ${season.slug}: ${taken} snapshots`);
    }
  }

  private async currentSeason(): Promise<CompetitionSeason> {
    const now = new Date();
    const season =
      (await this.seasonRepo.findOne({ where: { start_at: LessThanOrEqual(now) }, order: { start_at: 'DESC' } })) ??
      (await this.seasonRepo.findOne({ where: {}, order: { start_at: 'ASC' } }));
    if (!season) throw new NotFoundException('No competition season');
    return season;
  }

  async getLeaderboard(slug?: string): Promise<LeaderboardResponse> {
    const season = slug ? await this.seasonRepo.findOne({ where: { slug } }) : await this.currentSeason();
    if (!season) throw new NotFoundException('Competition season not found');

    const entries = await this.entryRepo
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.vault', 'v')
      .leftJoinAndSelect('v.owner', 'o')
      .leftJoinAndSelect('v.ft_token_img', 'img')
      .leftJoinAndSelect('v.vault_image', 'vimg')
      .where('e.season_id = :sid', { sid: season.id })
      .andWhere('e.status != :dq', { dq: CompetitionEntryStatus.disqualified })
      // A vault that failed or was burned after entering drops off the board.
      .andWhere('v.vault_status NOT IN (:...dead)', { dead: [VaultStatus.failed, VaultStatus.burned] })
      .getMany();

    const snapshots = entries.length
      ? await this.snapshotRepo
          .createQueryBuilder('s')
          .where('s.season_id = :sid', { sid: season.id })
          .andWhere('s.taken_at <= :end', { end: season.end_at })
          .orderBy('s.taken_at', 'ASC')
          .getMany()
      : [];
    const byVault = new Map<string, CompetitionSnapshot[]>();
    snapshots.forEach(s => {
      const list = byVault.get(s.vault_id) ?? [];
      list.push(s);
      byVault.set(s.vault_id, list);
    });

    const now = Date.now();
    const minLiquidity = num(season.min_liquidity_usd);
    let updatedAt: Date | null = null;

    const rows: LeaderboardRow[] = entries.flatMap(entry => {
      const list = byVault.get(entry.vault_id) ?? [];
      const latest = list[list.length - 1];
      if (!latest) return [];
      if (!updatedAt || latest.taken_at > updatedAt) updatedAt = latest.taken_at;

      const enteredMs = new Date(entry.entered_at).getTime();
      const windowEnd = enteredMs + QUALIFYING_WINDOW_MS;
      const window = list.filter(s => new Date(s.taken_at).getTime() <= windowEnd);
      const avg = (pick: (s: CompetitionSnapshot) => number): number =>
        window.length ? window.reduce((sum, s) => sum + pick(s), 0) / window.length : 0;

      // Token returns are measured in ETH: the pool prices the token in ETH, so a USD
      // return would mostly track ETH/USD and move every entry together. Entries made
      // before price_native existed fall back to USD.
      const entryNative = num(entry.entry_price_native);
      const useNative = entryNative > 0 && num(latest.price_native) > 0;
      const entryPrice = useNative ? entryNative : num(entry.entry_price_usd);
      const tokenPrice = (s: CompetitionSnapshot): number => (useNative ? num(s.price_native) : num(s.price_usd));
      const priceWindow = useNative ? window.filter(s => num(s.price_native) > 0) : window;
      const avgPrice = priceWindow.length
        ? priceWindow.reduce((sum, s) => sum + tokenPrice(s), 0) / priceWindow.length
        : 0;
      const entryValue = num(entry.entry_value_usd);
      const liquidityUsd = num(latest.liquidity_usd);

      let status: LeaderboardStatus = now >= windowEnd ? 'qualified' : 'qualifying';
      if (entry.status === CompetitionEntryStatus.review || (status === 'qualified' && liquidityUsd < minLiquidity)) {
        status = 'review';
      }

      const vault = entry.vault;
      return [
        {
          vaultId: entry.vault_id,
          symbol: vault?.vault_token_ticker ?? null,
          name: vault?.name ?? '',
          creator: vault?.owner?.name ?? null,
          imageUrl: vault?.ft_token_img?.file_url ?? vault?.vault_image?.file_url ?? null,
          enteredAt: entry.entered_at,
          status,
          qualifyingReturn: pctChange(entryPrice, avgPrice),
          totalReturn: pctChange(entryPrice, tokenPrice(latest)),
          qualifyingValueReturn: pctChange(
            entryValue,
            avg(s => num(s.value_usd))
          ),
          totalValueReturn: pctChange(entryValue, num(latest.value_usd)),
          priceUsd: num(latest.price_usd),
          value: num(latest.value_usd),
          liquidityUsd,
          holders: latest.holders,
        },
      ];
    });

    const tokens = [...rows].sort((a, b) => b.qualifyingReturn - a.qualifyingReturn);
    const portfolios = [...rows].sort((a, b) => b.qualifyingValueReturn - a.qualifyingValueReturn);

    return {
      season: {
        slug: season.slug,
        title: season.title,
        start: season.start_at,
        entryCutoff: season.entry_cutoff_at,
        promoEnd: season.promo_end_at,
        end: season.end_at,
      },
      updatedAt,
      tokens,
      portfolios,
    };
  }
}
