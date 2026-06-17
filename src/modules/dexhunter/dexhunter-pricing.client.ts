import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';

/**
 * DexHunter API client for token pricing and OHLCV data
 * Centralized client for DexHunter token price lookups and chart data
 *
 * Caches token price results for 5 minutes and OHLCV data for 5 minutes to reduce API calls.
 * Designed to support future Redis caching migration without breaking consumers.
 */
@Injectable()
export class DexHunterPricingClient {
  private readonly logger = new Logger(DexHunterPricingClient.name);
  private readonly isMainnet: boolean;
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;
  private readonly dexHunterChartsUrl: string;

  /**
   * Cache for token price results
   * TTL: 5 minutes (300 seconds) - matches existing pricing cache strategy
   */
  private readonly priceCache: NodeCache;

  /**
   * Cache for OHLCV (price history) results
   * TTL: 5 minutes (300 seconds) - matches pricing cache strategy
   */
  private readonly ohlcvCache: NodeCache;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.dexHunterChartsUrl = 'https://charts.dhapi.io';

    // Initialize price cache with 5-minute TTL
    this.priceCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
      useClones: false, // Don't clone objects for better performance
    });

    // Initialize OHLCV cache with 5-minute TTL
    this.ohlcvCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
      useClones: false, // Don't clone objects for better performance
    });
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

    const priceMap = new Map<string, number | null>();
    const tokensToFetch: string[] = [];
    const cacheHits: string[] = [];

    // Check cache first for all tokens
    tokenIds.forEach(tokenId => {
      const cacheKey = `token_price_${tokenId}`;
      const cached = this.priceCache.get<number | null>(cacheKey);
      if (cached !== undefined) {
        priceMap.set(tokenId, cached);
        cacheHits.push(tokenId);
      } else {
        tokensToFetch.push(tokenId);
      }
    });

    // If all tokens found in cache, return early
    if (tokensToFetch.length === 0) {
      return priceMap;
    }

    this.logger.log(`Fetching ${tokensToFetch.length} token prices from DexHunter API`);

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

      // Map results and cache
      results.forEach(({ tokenId, price }) => {
        priceMap.set(tokenId, price);
        this.priceCache.set(`token_price_${tokenId}`, price);
      });
    }

    return priceMap;
  }

  /**
   * Map TapTools interval format to DexHunter period format
   * TapTools: '1h', '1d', '1w', '1M'
   * DexHunter: '1hour', '1day', '1week' (no monthly support)
   */
  private mapIntervalToDexHunterPeriod(interval: string): string | null {
    const mapping: Record<string, string> = {
      '1h': '1hour',
      '1d': '1day',
      '1w': '1week',
    };
    return mapping[interval] || null;
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

    // Map TapTools interval to DexHunter period
    const period = this.mapIntervalToDexHunterPeriod(interval);
    if (!period) {
      this.logger.warn(`Unsupported interval for DexHunter: ${interval} (supports: 1h, 1d, 1w)`);
      return null;
    }

    const tokenUnit = scriptHash + assetName;
    const cacheKey = `ohlcv_${tokenUnit}_${interval}_${numIntervals || 'all'}`;

    // Check cache first
    const cached = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);
    if (cached !== undefined) {
      this.logger.debug(`DexHunter OHLCV cache hit for ${tokenUnit.slice(0, 16)}... (${interval})`);
      return cached;
    }

    try {
      // Calculate time range
      const to = Math.floor(Date.now() / 1000);
      let from: number;

      if (numIntervals) {
        // Calculate from based on number of intervals
        const intervalSeconds: Record<string, number> = {
          '1hour': 3600,
          '1day': 86400,
          '1week': 604800,
        };
        from = to - numIntervals * (intervalSeconds[period] || 3600);
      } else {
        // Default: get last 30 days
        from = to - 30 * 24 * 60 * 60;
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
        '1week': 604800,
      };
      const intervalDuration = intervalSeconds[period] || 3600;

      // Map DexHunter format to MarketOhlcvPoint format
      // DexHunter response doesn't include timestamps, so generate them based on from/period
      const ohlcvData: MarketOhlcvSeries = result.data.map((candle: any, index: number) => ({
        time: from + index * intervalDuration,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }));

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
   * Clear all caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    const priceSize = this.priceCache.keys().length;
    const ohlcvSize = this.ohlcvCache.keys().length;
    this.priceCache.flushAll();
    this.ohlcvCache.flushAll();
    this.logger.log(`Cleared caches (price: ${priceSize}, OHLCV: ${ohlcvSize} entries)`);
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    price: { size: number; hits: number; misses: number; keys: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
  } {
    const priceStats = this.priceCache.getStats();
    const ohlcvStats = this.ohlcvCache.getStats();
    return {
      price: {
        size: this.priceCache.keys().length,
        hits: priceStats.hits,
        misses: priceStats.misses,
        keys: priceStats.keys,
      },
      ohlcv: {
        size: this.ohlcvCache.keys().length,
        hits: ohlcvStats.hits,
        misses: ohlcvStats.misses,
        keys: ohlcvStats.keys,
      },
    };
  }
}
