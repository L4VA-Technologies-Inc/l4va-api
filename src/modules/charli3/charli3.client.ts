import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';
import { firstValueFrom } from 'rxjs';

import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';

/** Charli3 TradingView-format /history response */
interface Charli3HistoryResponse {
  s: 'ok' | 'no_data' | 'error';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  errmsg?: string;
}

/** Charli3 /symbol_info response (parallel arrays) */
interface Charli3SymbolInfo {
  symbol: string[];
  ticker: string[];
  base_currency: string[];
  currency: string[];
  description: string[];
  type: string[];
}

interface Charli3Group {
  id: string;
  name?: string;
}

interface Charli3GroupsResponse {
  d: { groups: Charli3Group[] };
}

type Charli3Resolution = '1min' | '15min' | '60min' | '1d';

/** Map TapTools interval → Charli3 resolution */
const INTERVAL_TO_RESOLUTION: Record<string, Charli3Resolution> = {
  '1h': '60min',
  '1d': '1d',
  '1w': '1d',
  '1M': '1d',
};

/** Seconds per timeframe label for price-change calculation */
const TIMEFRAME_SECONDS: Record<string, number> = {
  '1h': 3600,
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
};

const RESOLUTION_SECONDS: Record<Charli3Resolution, number> = {
  '1min': 60,
  '15min': 900,
  '60min': 3600,
  '1d': 86400,
};

/**
 * Charli3 API client for token pricing, OHLCV, and price change data.
 * Provides fallback pricing when TapTools API is unavailable.
 *
 * Tracks 14,000+ pools across all Cardano DEXes (MinswapV2, SundaeSwap, VyFi, etc.)
 * and provides aggregate (weighted-average) pricing suitable for ANY token with DEX liquidity.
 *
 * API Endpoints used:
 * - GET /groups            - List available DEX groups
 * - GET /symbol_info       - Pool list for a DEX group
 * - GET /history           - Historical OHLCV data (TradingView format)
 * - GET /tokens/current    - Current price, 1h/24h changes, volume, TVL
 */
@Injectable()
export class Charli3Client {
  private readonly logger = new Logger(Charli3Client.name);
  private readonly isMainnet: boolean;
  private readonly charli3ApiUrl: string;
  private readonly charli3ApiKey: string;

  /** Current price + 1h/24h changes — 5 min TTL */
  private readonly currentDataCache: NodeCache;
  /** Symbol info per group — 60 min TTL (pool list is stable) */
  private readonly symbolInfoCache: NodeCache;
  /** Pool ID lookups by token unit — 60 min TTL */
  private readonly poolIdCache: NodeCache;
  /** OHLCV series — 5 min TTL */
  private readonly ohlcvCache: NodeCache;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.charli3ApiUrl = this.configService.get<string>('CHARLI3_API_URL') || 'https://api.charli3.io/api/v1';
    this.charli3ApiKey = this.configService.get<string>('CHARLI3_API_KEY');

    this.currentDataCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });
    this.symbolInfoCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false });
    this.poolIdCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false });
    this.ohlcvCache = new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false });
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.charli3ApiKey}` };
  }

  // ─── Group / Symbol Info ────────────────────────────────────────────────────

  /** Get available DEX groups (MinswapV2, SundaeSwap, Aggregate, …) */
  async getGroups(): Promise<Charli3Group[]> {
    const cacheKey = 'groups';
    const cached = this.symbolInfoCache.get<Charli3Group[]>(cacheKey);
    if (cached) return cached;

    try {
      const res = await firstValueFrom(
        this.httpService.get<Charli3GroupsResponse>(`${this.charli3ApiUrl}/groups`, {
          headers: this.authHeaders,
          timeout: 10000,
        })
      );
      const groups = res.data?.d?.groups ?? [];
      this.symbolInfoCache.set(cacheKey, groups);
      return groups;
    } catch (error) {
      this.logger.debug(`Failed to fetch Charli3 groups: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Get symbol info (pool list) for a specific DEX group */
  async getSymbolInfo(group: string): Promise<Charli3SymbolInfo | null> {
    const cacheKey = `symbol_info_${group}`;
    const cached = this.symbolInfoCache.get<Charli3SymbolInfo>(cacheKey);
    if (cached) return cached;

    try {
      const res = await firstValueFrom(
        this.httpService.get<Charli3SymbolInfo>(`${this.charli3ApiUrl}/symbol_info`, {
          params: { group },
          headers: this.authHeaders,
          timeout: 15000,
        })
      );
      if (res.data?.ticker?.length) {
        this.symbolInfoCache.set(cacheKey, res.data);
        return res.data;
      }
      return null;
    } catch (error) {
      this.logger.debug(
        `Failed to fetch Charli3 symbol info for group ${group}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Find the Charli3 pool ticker (pool ID) for a token.
   * Tries Aggregate first (weighted-average across all DEXes), then individual DEXes.
   *
   * @param unit - Full token unit (policyId + assetName in hex)
   */
  async findPoolId(unit: string): Promise<string | null> {
    const cacheKey = `pool_id_${unit}`;
    const cached = this.poolIdCache.get<string | null>(cacheKey);
    if (cached !== undefined) return cached;

    // Try Aggregate first
    const aggInfo = await this.getSymbolInfo('Aggregate');
    if (aggInfo) {
      const poolId = this.findInSymbolInfo(aggInfo, unit);
      if (poolId) {
        this.poolIdCache.set(cacheKey, poolId);
        return poolId;
      }
    }

    // Fall back to individual DEX groups
    const groups = await this.getGroups();
    for (const group of groups) {
      if (group.id === 'Aggregate') continue;
      const info = await this.getSymbolInfo(group.id);
      if (!info) continue;
      const poolId = this.findInSymbolInfo(info, unit);
      if (poolId) {
        this.poolIdCache.set(cacheKey, poolId);
        return poolId;
      }
    }

    this.poolIdCache.set(cacheKey, null); // cache miss
    return null;
  }

  /** Scan parallel symbol arrays for a token unit (ADA pairs use "" as base) */
  private findInSymbolInfo(info: Charli3SymbolInfo, unit: string): string | null {
    for (let i = 0; i < info.ticker.length; i++) {
      const base = info.base_currency[i];
      const curr = info.currency[i];
      if ((base === '' && curr === unit) || (curr === '' && base === unit)) {
        return info.ticker[i];
      }
    }
    return null;
  }

  // ─── OHLCV ──────────────────────────────────────────────────────────────────

  /**
   * Get historical OHLCV data for a token.
   * Converts Charli3 TradingView format to MarketOhlcvSeries.
   *
   * @param unit         - Full token unit (policyId + assetName in hex)
   * @param interval     - TapTools-style interval ('1h', '1d', '1w', '1M')
   * @param numIntervals - How many intervals to fetch (omit for ~500 bars)
   */
  async getTokenOHLCV(unit: string, interval: string, numIntervals?: number): Promise<MarketOhlcvSeries | null> {
    if (!this.isMainnet) return null;

    const resolution = INTERVAL_TO_RESOLUTION[interval];
    if (!resolution) {
      this.logger.debug(`Charli3: unsupported interval '${interval}'`);
      return null;
    }

    // Weekly/monthly use daily resolution with multiplied bar count
    let bars = numIntervals ?? 500;
    if (interval === '1w' && numIntervals) bars = numIntervals * 7;
    if (interval === '1M' && numIntervals) bars = numIntervals * 30;

    const cacheKey = `ohlcv_${unit}_${interval}_${bars}`;
    const cached = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);
    if (cached !== undefined) return cached;

    const poolId = await this.findPoolId(unit);
    if (!poolId) {
      this.logger.debug(`Charli3: no pool found for ${unit.slice(0, 10)}...`);
      return null;
    }

    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - bars * RESOLUTION_SECONDS[resolution];

      const res = await firstValueFrom(
        this.httpService.get<Charli3HistoryResponse>(`${this.charli3ApiUrl}/history`, {
          params: { symbol: poolId, resolution, from, to },
          headers: this.authHeaders,
          timeout: 15000,
        })
      );

      const data = res.data;
      if (data?.s !== 'ok' || !data.t?.length) {
        this.logger.debug(`Charli3: no OHLCV data for ${unit.slice(0, 10)}... (${interval})`);
        return null;
      }

      const series: MarketOhlcvSeries = data.t.map((time, i) => ({
        time,
        open: data.o![i],
        high: data.h![i],
        low: data.l![i],
        close: data.c![i],
        volume: data.v![i],
      }));

      this.ohlcvCache.set(cacheKey, series);
      return series;
    } catch (error) {
      this.logger.debug(
        `Charli3 OHLCV fetch failed for ${unit.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Calculate price change percentages from OHLCV history.
   * Supports all timeframes including 7d and 30d (unlike getTokenCurrent which only gives 1h/24h).
   *
   * @param unit       - Full token unit
   * @param timeframes - Comma-separated ('1h,24h,7d,30d')
   */
  async calculatePriceChanges(
    unit: string,
    timeframes: string = '1h,24h,7d,30d'
  ): Promise<Record<string, number> | null> {
    if (!this.isMainnet) return null;

    const frames = timeframes.split(',').map(t => t.trim());
    const maxSeconds = Math.max(...frames.map(tf => TIMEFRAME_SECONDS[tf] ?? 86400));

    // Use hourly for short windows, daily for long
    const resolution: Charli3Resolution = maxSeconds <= 86400 ? '60min' : '1d';
    const resSeconds = RESOLUTION_SECONDS[resolution];
    const bars = Math.ceil(maxSeconds / resSeconds) + 5; // extra buffer

    const poolId = await this.findPoolId(unit);
    if (!poolId) return null;

    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - bars * resSeconds;

      const res = await firstValueFrom(
        this.httpService.get<Charli3HistoryResponse>(`${this.charli3ApiUrl}/history`, {
          params: { symbol: poolId, resolution, from, to },
          headers: this.authHeaders,
          timeout: 15000,
        })
      );

      const data = res.data;
      if (data?.s !== 'ok' || !data.t?.length || !data.c?.length) return null;

      const currentPrice = data.c[data.c.length - 1];
      if (!currentPrice) return null;

      const result: Record<string, number> = {};
      for (const tf of frames) {
        const secondsBack = TIMEFRAME_SECONDS[tf];
        if (!secondsBack) {
          result[tf] = 0;
          continue;
        }

        const targetTs = to - secondsBack;
        let oldPrice = data.c[0];
        for (let i = 0; i < data.t.length; i++) {
          if (data.t[i] <= targetTs) oldPrice = data.c[i];
          else break;
        }
        result[tf] = oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : 0;
      }

      return result;
    } catch (error) {
      this.logger.debug(
        `Charli3 price change calc failed for ${unit.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  // ─── Current Price (fast path) ─────────────────────────────────────────────

  /**
   * Get current token data including price and 1h/24h changes.
   *
   * @param unit - Token unit (policyId + assetName in hex)
   */
  async getTokenCurrent(unit: string): Promise<{
    current_price: number;
    current_tvl: number;
    hourly_price_change: number;
    daily_price_change: number;
    hourly_tvl_change: number;
    daily_tvl_change: number;
    hourly_volume: number;
    daily_volume: number;
  } | null> {
    // Skip API calls for testnet/preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping Charli3 API call for non-mainnet environment`);
      return null;
    }

    // Check cache first
    const cacheKey = `current_${unit}`;
    const cached = this.currentDataCache.get<{
      current_price: number;
      current_tvl: number;
      hourly_price_change: number;
      daily_price_change: number;
      hourly_tvl_change: number;
      daily_tvl_change: number;
      hourly_volume: number;
      daily_volume: number;
    }>(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<{
          current_price: number;
          current_tvl: number;
          hourly_price_change: number;
          daily_price_change: number;
          hourly_tvl_change: number;
          daily_tvl_change: number;
          hourly_volume: number;
          daily_volume: number;
        }>(`${this.charli3ApiUrl}/tokens/current`, {
          params: { policy: unit },
          headers: {
            Authorization: `Bearer ${this.charli3ApiKey}`,
          },
          timeout: 10000, // 10 second timeout
        })
      );

      if (response.data) {
        // Cache the result
        this.currentDataCache.set(cacheKey, response.data);
        return response.data;
      }

      return null;
    } catch (error) {
      // Don't log at warn level - this is expected when token doesn't exist or has no LP
      if ((error as any)?.response?.status === 404) {
        this.logger.debug(`Token not found on Charli3: ${unit.slice(0, 10)}...`);
      } else {
        this.logger.debug(
          `Failed to fetch current data from Charli3 for unit ${unit.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Get token market data formatted like TapTools for compatibility
   * Maps Charli3 data to TapTools format for seamless fallback
   *
   * Note: FDV, circulating supply, market cap, and total supply are NOT available
   * from Charli3 and will be returned as 0/null
   *
   * @param unit - Token unit (policyId + assetName in hex)
   * @returns Market cap data (partial) or null if unavailable
   */
  async getTokenMarketCap(unit: string): Promise<{
    price: number;
    fdv: number;
    circSupply: number;
    mcap: number;
    totalSupply: number;
  } | null> {
    const currentData = await this.getTokenCurrent(unit);

    if (!currentData || !currentData.current_price) {
      return null;
    }

    // Map Charli3 data to TapTools format
    // Note: FDV, supply, and mcap are NOT available from Charli3
    return {
      price: currentData.current_price,
      fdv: 0, // Not available from Charli3
      circSupply: 0, // Not available from Charli3
      mcap: 0, // Not available from Charli3
      totalSupply: 0, // Not available from Charli3
    };
  }

  /**
   * Get token price changes.
   * Uses calculatePriceChanges() from OHLCV for full 7d/30d support.
   * Falls back to getTokenCurrent() for 1h/24h when OHLCV is unavailable.
   *
   * @param unit       - Token unit (policyId + assetName in hex)
   * @param timeframes - Comma-separated timeframes ('1h,24h,7d,30d')
   */
  async getTokenPriceChanges(
    unit: string,
    timeframes: string = '1h,24h,7d,30d'
  ): Promise<Record<string, number> | null> {
    // Try full OHLCV-based calculation first (supports all timeframes)
    const ohlcvChanges = await this.calculatePriceChanges(unit, timeframes);
    if (ohlcvChanges) return ohlcvChanges;

    // Fallback: current endpoint for 1h/24h only
    const currentData = await this.getTokenCurrent(unit);
    if (!currentData) return null;

    const frames = timeframes.split(',').map(t => t.trim());
    const result: Record<string, number> = {};
    for (const tf of frames) {
      if (tf === '1h') result[tf] = currentData.hourly_price_change || 0;
      else if (tf === '24h') result[tf] = currentData.daily_price_change || 0;
      else result[tf] = 0; // 7d/30d unavailable without OHLCV
    }
    return result;
  }

  // ─── Cache utilities ────────────────────────────────────────────────────────

  /** Clear all caches */
  clearCache(): void {
    const counts = [this.currentDataCache, this.symbolInfoCache, this.poolIdCache, this.ohlcvCache].map(c => {
      const n = c.keys().length;
      c.flushAll();
      return n;
    });
    this.logger.log(`Cleared Charli3 caches (${counts.join('+')} keys deleted)`);
  }

  /** Get cache statistics */
  getCacheStats(): {
    currentData: { size: number; hits: number; misses: number; keys: number };
    symbolInfo: { size: number; hits: number; misses: number; keys: number };
    poolId: { size: number; hits: number; misses: number; keys: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
  } {
    const stat = (c: NodeCache): { size: number; hits: number; misses: number; keys: number } => ({
      size: c.keys().length,
      hits: c.getStats().hits,
      misses: c.getStats().misses,
      keys: c.getStats().keys,
    });
    return {
      currentData: stat(this.currentDataCache),
      symbolInfo: stat(this.symbolInfoCache),
      poolId: stat(this.poolIdCache),
      ohlcv: stat(this.ohlcvCache),
    };
  }
}
