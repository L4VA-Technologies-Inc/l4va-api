import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import NodeCache from 'node-cache';

import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';

/**
 * DexHunter API client for token pricing and OHLCV data
 * Centralized client for DexHunter token price lookups and chart data
 *
 * Price caching: Redis with 10-minute TTL (supports VyFi bulk refresh)
 * OHLCV caching: node-cache with 5-minute TTL (chart data)
 */
@Injectable()
export class DexHunterPricingClient {
  private readonly logger = new Logger(DexHunterPricingClient.name);
  private readonly isMainnet: boolean;
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;
  private readonly dexHunterChartsUrl: string;

  /**
   * Redis TTL for token prices (10 minutes = 600 seconds)
   * Matches VyFi bulk refresh interval
   */
  private readonly PRICE_TTL_SECONDS = 600;

  /**
   * Cache for OHLCV (price history) results
   * TTL: 5 minutes (300 seconds)
   */
  private readonly ohlcvCache: NodeCache;

  constructor(
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.dexHunterChartsUrl = 'https://charts.dhapi.io';

    // Initialize OHLCV cache with 5-minute TTL
    this.ohlcvCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
      useClones: false, // Don't clone objects for better performance
    });
  }

  /**
   * Get token price from Redis cache
   * @param tokenUnit - Full token unit (policyId + assetName)
   * @returns Price in ADA or null if not cached
   */
  async getRedisPrice(tokenUnit: string): Promise<number | null> {
    try {
      const key = `vyfi_price:${tokenUnit}`;
      const value = await this.redis.get(key);
      if (!value) return null;

      // Parse format: {priceAda}:{timestamp}
      const [priceStr] = value.split(':');
      const price = parseFloat(priceStr);
      return isNaN(price) ? null : price;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis get price failed for ${tokenUnit.slice(0, 10)}...: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Get multiple token prices from Redis cache using pipeline
   * @param tokenUnits - Array of token units
   * @returns Map of tokenUnit -> price in ADA (null if not cached)
   */
  async getRedisPrices(tokenUnits: string[]): Promise<Map<string, number | null>> {
    const resultMap = new Map<string, number | null>();
    if (tokenUnits.length === 0) return resultMap;

    try {
      const pipeline = this.redis.pipeline();
      tokenUnits.forEach(unit => {
        pipeline.get(`vyfi_price:${unit}`);
      });

      const results = await pipeline.exec();
      if (!results) {
        // If pipeline returns null, set all tokens to null to trigger fallback
        tokenUnits.forEach(unit => resultMap.set(unit, null));
        return resultMap;
      }

      results.forEach(([err, value], index) => {
        const tokenUnit = tokenUnits[index];
        if (err || !value) {
          resultMap.set(tokenUnit, null);
          return;
        }

        const [priceStr] = (value as string).split(':');
        const price = parseFloat(priceStr);
        resultMap.set(tokenUnit, isNaN(price) ? null : price);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis batch get prices failed: ${errorMessage}`);
      tokenUnits.forEach(unit => resultMap.set(unit, null));
    }

    return resultMap;
  }

  /**
   * Set token price in Redis cache
   * @param tokenUnit - Full token unit
   * @param priceAda - Price in ADA
   */
  async setRedisPrice(tokenUnit: string, priceAda: number): Promise<void> {
    try {
      const key = `vyfi_price:${tokenUnit}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const value = `${priceAda}:${timestamp}`;
      await this.redis.setex(key, this.PRICE_TTL_SECONDS, value);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis set price failed for ${tokenUnit.slice(0, 10)}...: ${errorMessage}`);
    }
  }

  /**
   * Set multiple token prices in Redis using pipeline
   * @param pricesMap - Map of tokenUnit -> price in ADA
   */
  async setRedisPrices(pricesMap: Map<string, number>): Promise<void> {
    if (pricesMap.size === 0) return;

    try {
      const pipeline = this.redis.pipeline();
      const timestamp = Math.floor(Date.now() / 1000);

      pricesMap.forEach((priceAda, tokenUnit) => {
        const key = `vyfi_price:${tokenUnit}`;
        const value = `${priceAda}:${timestamp}`;
        pipeline.setex(key, this.PRICE_TTL_SECONDS, value);
      });

      await pipeline.exec();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis batch set prices failed: ${errorMessage}`);
    }
  }

  /**
   * Sanitize error response text - detect HTML error pages and extract concise error info
   * Prevents massive HTML dumps in logs when external APIs return error pages
   */
  private sanitizeErrorText(text: string, statusCode: number): string {
    // Detect HTML error pages (Cloudflare, nginx, etc.)
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      // Extract error code if present (e.g., "Error code 520")
      const errorCodeMatch = text.match(/Error code (\d+)/i);
      const errorCode = errorCodeMatch ? errorCodeMatch[1] : statusCode;

      // Extract title if present
      const titleMatch = text.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'HTML Error Page';

      // Check for Cloudflare-specific errors
      if (text.includes('cloudflare')) {
        return `Cloudflare error ${errorCode}: ${title} (upstream server issue)`;
      }

      return `HTML error page (${errorCode}): ${title}`;
    }

    // Not HTML - return original text (truncated if very long)
    return text.length > 500 ? text.substring(0, 500) + '... (truncated)' : text;
  }

  /**
   * Get token prices for multiple tokens
   * Note: DexHunter doesn't have a native batch endpoint, so we fetch individually
   * Results are cached to avoid redundant API calls
   *
   * @param tokenIds - Array of token identifiers (policyId + assetName in hex)
   * @returns Map of tokenId to price in ADA (null if not found)
   */
  async getTokenPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    // Skip API calls for testnet/preprod - DexHunter doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping DexHunter API call for non-mainnet environment (${tokenIds.length} tokens)`);
      // Return null for all tokens
      const resultMap = new Map<string, number | null>();
      tokenIds.forEach(tokenId => resultMap.set(tokenId, null));
      return resultMap;
    }

    // Handle lovelace (ADA) - price is always 1.0 ADA
    const resultMap = new Map<string, number | null>();
    const nonLovelaceTokens = tokenIds.filter(tokenId => {
      if (tokenId === 'lovelace') {
        resultMap.set(tokenId, 1.0);
        return false; // Filter out from API calls
      }
      return true;
    });

    // If only lovelace tokens were requested, return early
    if (nonLovelaceTokens.length === 0) {
      return resultMap;
    }

    // Check Redis cache first
    const cachedPrices = await this.getRedisPrices(nonLovelaceTokens);
    const tokensToFetch: string[] = [];

    cachedPrices.forEach((price, tokenId) => {
      if (price !== null) {
        resultMap.set(tokenId, price);
      } else {
        tokensToFetch.push(tokenId);
      }
    });

    // If all tokens found in Redis cache (or were lovelace), return early
    if (tokensToFetch.length === 0) {
      return resultMap;
    }

    // DexHunter doesn't have batch endpoint - fetch with concurrency control
    const concurrencyLimit = 10;
    for (let i = 0; i < tokensToFetch.length; i += concurrencyLimit) {
      const batch = tokensToFetch.slice(i, i + concurrencyLimit);

      const results = await Promise.all(
        batch.map(async tokenId => {
          try {
            const response = await fetch(`${this.dexHunterBaseUrl}/swap/averagePrice/ADA/${tokenId}`, {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'X-Partner-Id': this.dexHunterApiKey,
              },
            });

            if (!response.ok) {
              if (response.status === 404) {
                this.logger.debug(`DexHunter: Token ${tokenId.slice(0, 8)}... not found or has no liquidity`);
              } else {
                const errorText = await response.text();
                const sanitizedError = this.sanitizeErrorText(errorText, response.status);
                this.logger.warn(
                  `DexHunter API error (${response.status}) for token ${tokenId.slice(0, 8)}...: ${sanitizedError}`
                );
              }
              return { tokenId, price: null };
            }

            const data = await response.json();
            const priceAda = data.price_ba;

            if (priceAda && priceAda > 0) {
              return { tokenId, price: priceAda };
            } else {
              this.logger.debug(`DexHunter returned zero/null price for token ${tokenId.slice(0, 8)}...`);
              return { tokenId, price: null };
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(`DexHunter API failed for token ${tokenId.slice(0, 8)}...: ${errorMessage}`);
            return { tokenId, price: null };
          }
        })
      );

      // Map results and cache in Redis
      results.forEach(({ tokenId, price }) => {
        resultMap.set(tokenId, price);
        if (price !== null) {
          this.setRedisPrice(tokenId, price).catch(err =>
            this.logger.error(`Failed to cache price for ${tokenId.slice(0, 8)}...: ${err.message}`)
          );
        }
      });
    }

    return resultMap;
  }

  /**
   * Map TapTools interval format to DexHunter period format
   * TapTools: '1h', '1d', '1w', '1M'
   * DexHunter: '1hour', '1day' (1week not actually supported, constructed from daily)
   */
  private mapIntervalToDexHunterPeriod(interval: string): string | null {
    const mapping: Record<string, string> = {
      '1h': '1hour',
      '1d': '1day',
      '1w': '1day', // Fetch daily data, aggregate to weekly
    };
    return mapping[interval] || null;
  }

  /**
   * Aggregate daily OHLCV data into weekly candles
   * Groups 7 consecutive days into one weekly candle
   * Filters out zero-volume candles and extreme outliers for cleaner charts
   */
  private aggregateDailyToWeekly(dailyCandles: MarketOhlcvSeries): MarketOhlcvSeries {
    if (!dailyCandles || dailyCandles.length === 0) {
      return [];
    }

    // Filter out zero-volume candles (no trading activity)
    const activeCandles = dailyCandles.filter(c => c.volume > 0);

    if (activeCandles.length === 0) {
      return [];
    }

    // Calculate median close price to detect outliers
    const closePrices = activeCandles.map(c => c.close).sort((a, b) => a - b);
    const medianPrice = closePrices[Math.floor(closePrices.length / 2)];

    // Filter extreme outliers (prices > 10x median, likely thin order book trades)
    const filteredCandles = activeCandles.filter(c => {
      const priceRatio = Math.max(c.high / medianPrice, medianPrice / c.low);
      return priceRatio < 10; // Skip candles with 10x+ price deviation
    });

    if (filteredCandles.length === 0) {
      return [];
    }

    const weeklyCandles: MarketOhlcvSeries = [];
    const WEEK_IN_SECONDS = 7 * 24 * 60 * 60; // 604800 seconds

    // Group candles by week
    let weekStart = Math.floor(filteredCandles[0].time / WEEK_IN_SECONDS) * WEEK_IN_SECONDS;
    let weekCandles: typeof filteredCandles = [];

    for (const candle of filteredCandles) {
      const candleWeekStart = Math.floor(candle.time / WEEK_IN_SECONDS) * WEEK_IN_SECONDS;

      // Check if this candle belongs to the current week
      if (candleWeekStart === weekStart) {
        weekCandles.push(candle);
      } else {
        // Complete the previous week if we have candles
        if (weekCandles.length > 0) {
          weeklyCandles.push({
            time: weekStart,
            open: weekCandles[0].open,
            high: Math.max(...weekCandles.map(c => c.high)),
            low: Math.min(...weekCandles.map(c => c.low)),
            close: weekCandles[weekCandles.length - 1].close,
            volume: weekCandles.reduce((sum, c) => sum + c.volume, 0),
          });
        }

        // Start new week
        weekStart = candleWeekStart;
        weekCandles = [candle];
      }
    }

    // Add the last week if we have candles
    if (weekCandles.length > 0) {
      weeklyCandles.push({
        time: weekStart,
        open: weekCandles[0].open,
        high: Math.max(...weekCandles.map(c => c.high)),
        low: Math.min(...weekCandles.map(c => c.low)),
        close: weekCandles[weekCandles.length - 1].close,
        volume: weekCandles.reduce((sum, c) => sum + c.volume, 0),
      });
    }

    return weeklyCandles;
  }

  /**
   * Get OHLCV (Open, High, Low, Close, Volume) data for a token
   * Fetches historical price data from DexHunter Charts API
   *
   * @param scriptHash - Token policy ID (script hash)
   * @param assetName - Token asset name in hex
   * @param interval - Time interval ('1h', '1d', '1w' - TapTools format)
   * @param numIntervals - Optional number of intervals to return (omit for recent data)
   * @returns OHLCV data array or null if unavailable
   */
  async getTokenOHLCV(
    scriptHash: string,
    assetName: string,
    interval: string,
    numIntervals?: number
  ): Promise<MarketOhlcvSeries | null> {
    // Skip API calls for testnet/preprod - DexHunter doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping DexHunter OHLCV call for non-mainnet environment`);
      return null;
    }

    const tokenUnit = scriptHash + assetName;
    const cacheKey = `ohlcv_${tokenUnit}_${interval}_${numIntervals || 'all'}`;

    // Check cache first
    const cached = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Map TapTools interval to DexHunter period (1w -> 1day, will aggregate later)
    const period = this.mapIntervalToDexHunterPeriod(interval);
    if (!period) {
      this.logger.warn(`Unsupported interval for DexHunter: ${interval} (supports: 1h, 1d, 1w)`);
      return null;
    }

    const isWeeklyInterval = interval === '1w';

    try {
      // Calculate time range
      const to = Math.floor(Date.now() / 1000);
      let from: number;

      if (numIntervals) {
        // Calculate from based on number of intervals
        // For weekly, multiply by 7 since we fetch daily and aggregate
        const intervalSeconds: Record<string, number> = {
          '1hour': 3600,
          '1day': 86400,
        };
        const multiplier = isWeeklyInterval ? 7 : 1;
        from = to - numIntervals * (intervalSeconds[period] || 3600) * multiplier;
      } else {
        // Default: get last 365 days (all-time data)
        from = to - 365 * 24 * 60 * 60;
      }

      const response = await fetch(`${this.dexHunterChartsUrl}/charts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Id': this.dexHunterApiKey,
        },
        body: JSON.stringify({
          tokenIn: '', // Empty string for ADA
          tokenOut: tokenUnit,
          period,
          from,
          to,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const sanitizedError = this.sanitizeErrorText(errorText, response.status);
        this.logger.warn(
          `DexHunter Charts API error (${response.status}) for token ${tokenUnit.slice(0, 16)}...: ${sanitizedError}`
        );
        // Cache null result to avoid repeated failed requests
        this.ohlcvCache.set(cacheKey, null);
        return null;
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        this.logger.debug(`DexHunter returned no OHLCV data for ${tokenUnit.slice(0, 16)}...`);
        this.ohlcvCache.set(cacheKey, null);
        return null;
      }

      // Calculate interval in seconds for timestamp generation
      const intervalSeconds: Record<string, number> = {
        '1hour': 3600,
        '1day': 86400,
      };
      const intervalDuration = intervalSeconds[period] || 3600;

      // Map DexHunter format to MarketOhlcvPoint format
      // DexHunter response doesn't include timestamps, so generate them based on from/period
      let ohlcvData: MarketOhlcvSeries = result.data.map((candle: any, index: number) => ({
        time: from + index * intervalDuration,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }));

      // If weekly interval requested, aggregate daily data into weekly candles
      if (isWeeklyInterval) {
        ohlcvData = this.aggregateDailyToWeekly(ohlcvData);
        this.logger.debug(
          `Aggregated ${result.data.length} daily candles into ${ohlcvData.length} weekly candles for ${tokenUnit.slice(0, 16)}...`
        );
      }

      // this.logger.log(`DexHunter OHLCV success for ${tokenUnit.slice(0, 16)}...: ${ohlcvData.length} data points`);

      // Cache the result
      this.ohlcvCache.set(cacheKey, ohlcvData);
      return ohlcvData;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`DexHunter OHLCV fetch failed for ${tokenUnit.slice(0, 16)}...: ${errorMessage}`);
      // Cache null result to avoid repeated failed requests
      this.ohlcvCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Delete Redis keys by pattern using SCAN (memory-efficient, non-blocking)
   * Deletes keys while scanning to avoid collecting all keys in memory
   * @param pattern - Redis key pattern to match
   * @returns Number of keys deleted
   */
  private async deleteRedisKeysByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += keys.length;
        // UNLINK is better than DEL because it deletes asynchronously
        await this.redis.unlink(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }

  /**
   * Count Redis keys by pattern using SCAN (non-blocking)
   * @param pattern - Redis key pattern to match
   * @returns Number of keys matching the pattern
   */
  private async countRedisKeysByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let count = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    return count;
  }

  /**
   * Clear all caches (useful for testing or manual refresh)
   */
  async clearCache(): Promise<void> {
    try {
      // Clear Redis price cache using SCAN + UNLINK
      const deletedPriceKeys = await this.deleteRedisKeysByPattern('vyfi_price:*');

      // Clear OHLCV cache
      const ohlcvSize = this.ohlcvCache.keys().length;
      this.ohlcvCache.flushAll();

      this.logger.log(`Cleared caches (Redis price keys: ${deletedPriceKeys}, OHLCV: ${ohlcvSize} entries)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to clear caches: ${errorMessage}`);
    }
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  async getCacheStats(): Promise<{
    price: { size: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
  }> {
    try {
      // Use SCAN to count keys instead of KEYS (non-blocking)
      const priceKeyCount = await this.countRedisKeysByPattern('vyfi_price:*');
      const ohlcvStats = this.ohlcvCache.getStats();

      return {
        price: {
          size: priceKeyCount,
        },
        ohlcv: {
          size: this.ohlcvCache.keys().length,
          hits: ohlcvStats.hits,
          misses: ohlcvStats.misses,
          keys: ohlcvStats.keys,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to get cache stats: ${errorMessage}`);
      return {
        price: { size: 0 },
        ohlcv: { size: 0, hits: 0, misses: 0, keys: 0 },
      };
    }
  }
}
