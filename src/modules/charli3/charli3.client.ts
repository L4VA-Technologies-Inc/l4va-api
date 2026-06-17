import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';
import { firstValueFrom } from 'rxjs';

/**
 * Charli3 API client for token pricing and price change data
 * Provides fallback pricing when TapTools API is unavailable
 *
 * Caches token data for 5 minutes to reduce API calls.
 *
 * API Endpoints:
 * - GET /tokens/current - Current price, price changes (1h, 24h), volume, TVL
 * - GET /history - Historical OHLCV data
 *
 * @see https://docs.charli3.io/cardano-price-api/api-reference/token-data
 */
@Injectable()
export class Charli3Client {
  private readonly logger = new Logger(Charli3Client.name);
  private readonly isMainnet: boolean;
  private readonly charli3ApiUrl: string;
  private readonly charli3ApiKey: string;

  /**
   * Cache for token current data (price, changes, volume)
   * TTL: 5 minutes (300 seconds) - matches TapTools cache strategy
   */
  private readonly currentDataCache: NodeCache;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.charli3ApiUrl = this.configService.get<string>('CHARLI3_API_URL') || 'https://api.charli3.io/api/v1';
    this.charli3ApiKey = this.configService.get<string>('CHARLI3_API_KEY');

    // Initialize cache with 5-minute TTL
    this.currentDataCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
      useClones: false, // Don't clone objects for better performance
    });
  }

  /**
   * Get current token data including price and price changes
   *
   * Returns price, hourly/daily changes, volume, and TVL from Charli3 API
   *
   * @param unit - Token unit (policyId + assetName in hex)
   * @returns Current token data or null if unavailable
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
      if (error.response?.status === 404) {
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
   * Get token price changes formatted like TapTools for compatibility
   * Maps Charli3 hourly/daily changes to TapTools format
   *
   * Note: Only 1h and 24h changes are available from Charli3.
   * 7d and 30d changes will be returned as 0.
   *
   * @param unit - Token unit (policyId + assetName in hex)
   * @param timeframes - Timeframes string (ignored, Charli3 only provides 1h/24h)
   * @returns Price changes object or null if unavailable
   */
  async getTokenPriceChanges(
    unit: string,
    timeframes: string = '1h,24h,7d,30d'
  ): Promise<Record<string, number> | null> {
    const currentData = await this.getTokenCurrent(unit);

    if (!currentData) {
      return null;
    }

    // Map Charli3 data to TapTools format
    // Note: Only 1h and 24h are available, 7d and 30d will be 0
    return {
      '1h': currentData.hourly_price_change || 0,
      '24h': currentData.daily_price_change || 0,
      '7d': 0, // Not available from Charli3
      '30d': 0, // Not available from Charli3
    };
  }

  /**
   * Clear all caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    const keysDeleted = this.currentDataCache.keys().length;
    this.currentDataCache.flushAll();
    this.logger.log(`Cleared Charli3 cache (${keysDeleted} keys deleted)`);
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    currentData: { size: number; hits: number; misses: number; keys: number };
  } {
    const currentDataStats = this.currentDataCache.getStats();
    return {
      currentData: {
        size: this.currentDataCache.keys().length,
        hits: currentDataStats.hits,
        misses: currentDataStats.misses,
        keys: currentDataStats.keys,
      },
    };
  }
}
