import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';
import { firstValueFrom } from 'rxjs';

import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';

/**
 * TapTools API client for token pricing and LP pool data
 * Centralized client for all TapTools API interactions
 *
 * Caches token price results for 5 minutes and LP pool data for 10 minutes
 * to reduce API calls and improve performance.
 * Designed to support future Redis caching migration without breaking consumers.
 */
@Injectable()
export class TapToolsClient {
  private readonly logger = new Logger(TapToolsClient.name);
  private readonly isMainnet: boolean;
  private readonly tapToolsApiUrl: string;
  private readonly tapToolsApiKey: string;

  /**
   * Cache for token price results
   * TTL: 5 minutes (300 seconds) - matches existing pricing cache strategy
   */
  private readonly priceCache: NodeCache;

  /**
   * Cache for token pool results
   * TTL: 10 minutes (600 seconds) - LP pool data doesn't change frequently
   */
  private readonly poolCache: NodeCache;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');

    // Initialize price cache with 5-minute TTL
    this.priceCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
      useClones: false, // Don't clone objects for better performance
    });

    // Initialize pool cache with 10-minute TTL
    this.poolCache = new NodeCache({
      stdTTL: 600, // 10 minutes in seconds
      checkperiod: 120, // Check for expired keys every 2 minutes
      useClones: false, // Don't clone objects for better performance
    });
  }

  /**
   * Get token prices for multiple tokens in batch
   * TapTools supports up to 100 tokens per batch request
   *
   * @param tokenIds - Array of token identifiers (policyId + assetName in hex)
   * @returns Map of tokenId to price in ADA (null if not found)
   */
  async getTokenPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    // Skip API calls for testnet/preprod - TapTools doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping TapTools API call for non-mainnet environment (${tokenIds.length} tokens)`);
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

    if (cacheHits.length > 0) {
      this.logger.debug(`Cache HIT for ${cacheHits.length}/${tokenIds.length} tokens`);
    }

    // If all tokens found in cache, return early
    if (tokensToFetch.length === 0) {
      return priceMap;
    }

    this.logger.log(`Fetching ${tokensToFetch.length} token prices from TapTools API`);

    // TapTools supports max 100 tokens per batch
    const batchSize = 100;
    for (let i = 0; i < tokensToFetch.length; i += batchSize) {
      const batch = tokensToFetch.slice(i, i + batchSize);

      try {
        const response = await firstValueFrom(
          this.httpService.post<Record<string, number | null>>(`${this.tapToolsApiUrl}/token/prices`, batch, {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.tapToolsApiKey,
            },
            timeout: 10000, // 10 second timeout
          })
        );

        const data = response.data;

        // Map response to price map and cache results
        batch.forEach(tokenId => {
          const price = data[tokenId];
          const normalizedPrice = price !== undefined && price !== null ? price : null;
          priceMap.set(tokenId, normalizedPrice);
          // Cache the result (including null values to avoid repeated failed lookups)
          this.priceCache.set(`token_price_${tokenId}`, normalizedPrice);
        });

        this.logger.debug(`Successfully fetched batch ${i / batchSize + 1} (${batch.length} tokens) from TapTools`);
      } catch (error) {
        // Log the error and set all tokens in batch to null
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `TapTools batch API failed for batch ${i / batchSize + 1} (${batch.length} tokens): ${errorMessage}`
        );

        // Set all tokens in failed batch to null and cache null results
        batch.forEach(tokenId => {
          priceMap.set(tokenId, null);
          this.priceCache.set(`token_price_${tokenId}`, null);
        });
      }
    }

    return priceMap;
  }

  /**
   * Get LP pools for a specific token unit
   * Caches results for 10 minutes since LP pool data is relatively static
   *
   * @param tokenUnit - Full token unit (policyId + assetName in hex)
   * @returns Array of LP pools containing this token
   */
  async getTokenPools(tokenUnit: string): Promise<TapToolsTokenPoolDto[]> {
    // Skip API calls for testnet/preprod - TapTools doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping TapTools API call for non-mainnet environment (token ${tokenUnit.slice(0, 5)}...)`);
      return [];
    }

    // Check cache first
    const cached = this.poolCache.get<TapToolsTokenPoolDto[]>(tokenUnit);
    if (cached !== undefined) {
      // this.logger.debug(`Cache HIT for token ${tokenUnit.slice(0, 5)}... (${cached.length} pools)`);
      return cached;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<TapToolsTokenPoolDto[]>(`${this.tapToolsApiUrl}/token/pools`, {
          params: { unit: tokenUnit },
          headers: {
            'x-api-key': this.tapToolsApiKey,
          },
        })
      );

      // Cache the result (TTL handled automatically by node-cache)
      this.poolCache.set(tokenUnit, response.data);

      // this.logger.debug(`Retrieved ${response.data.length} pools for token ${tokenUnit.slice(0, 6)}...`);

      return response.data;
    } catch (error) {
      // 404 is expected when tokens don't have LP pools - log as debug, not error
      const isAxiosError = error && typeof error === 'object' && 'response' in error;
      if (isAxiosError && (error as any).response?.status === 404) {
        // Cache empty results too (tokens without pools shouldn't be queried repeatedly)
        this.poolCache.set(tokenUnit, []);
        // this.logger.debug(`No LP pools found in TapTools for token ${tokenUnit.slice(0, 5)}... `);
      } else {
        this.logger.error(
          `Failed to get token pools from TapTools for ${tokenUnit.slice(0, 5)}...: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return [];
    }
  }

  /**
   * Get LP pool by onchain ID
   * Returns the first pool matching the onchain ID, or null if not found
   *
   * @param onchainID - Pool onchain identifier
   * @returns LP pool data or null
   */
  async getPoolByOnchainId(onchainID: string): Promise<TapToolsTokenPoolDto | null> {
    // Skip API calls for testnet/preprod - TapTools doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping TapTools API call for non-mainnet environment`);
      return null;
    }

    // Check cache first
    const cacheKey = `onchainID_${onchainID}`;
    const cached = this.poolCache.get<TapToolsTokenPoolDto | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<TapToolsTokenPoolDto[]>(`${this.tapToolsApiUrl}/token/pools`, {
          params: { onchainID },
          headers: {
            'x-api-key': this.tapToolsApiKey,
          },
        })
      );

      // Return first pool if array has results
      const result = response.data && response.data.length > 0 ? response.data[0] : null;

      // Cache the result (TTL handled automatically by node-cache)
      this.poolCache.set(cacheKey, result);

      return result;
    } catch (error) {
      const isAxiosError = error && typeof error === 'object' && 'response' in error;
      if (isAxiosError && (error as any).response?.status === 404) {
        // Cache null result
        this.poolCache.set(cacheKey, null);
      } else {
        this.logger.warn(
          `Failed to get pool by onchainID ${onchainID.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Clear all caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    const priceSize = this.priceCache.keys().length;
    const poolSize = this.poolCache.keys().length;
    this.priceCache.flushAll();
    this.poolCache.flushAll();
    this.logger.log(`Cleared caches - price: ${priceSize} entries, pool: ${poolSize} entries`);
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    price: { size: number; hits: number; misses: number; keys: number };
    pool: { size: number; hits: number; misses: number; keys: number };
  } {
    const priceStats = this.priceCache.getStats();
    const poolStats = this.poolCache.getStats();
    return {
      price: {
        size: this.priceCache.keys().length,
        hits: priceStats.hits,
        misses: priceStats.misses,
        keys: priceStats.keys,
      },
      pool: {
        size: this.poolCache.keys().length,
        hits: poolStats.hits,
        misses: poolStats.misses,
        keys: poolStats.keys,
      },
    };
  }
}
