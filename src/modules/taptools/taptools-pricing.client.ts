import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';
import { firstValueFrom } from 'rxjs';

/**
 * TapTools API client for token pricing
 * Centralized client for TapTools token price lookups
 *
 * Caches token price results for 5 minutes to reduce API calls and improve performance.
 * Designed to support future Redis caching migration without breaking consumers.
 */
@Injectable()
export class TapToolsPricingClient {
  private readonly logger = new Logger(TapToolsPricingClient.name);
  private readonly isMainnet: boolean;
  private readonly tapToolsApiUrl: string;
  private readonly tapToolsApiKey: string;

  /**
   * Cache for token price results
   * TTL: 5 minutes (300 seconds) - matches existing pricing cache strategy
   */
  private readonly priceCache: NodeCache;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');

    // Initialize cache with 5-minute TTL
    this.priceCache = new NodeCache({
      stdTTL: 300, // 5 minutes in seconds
      checkperiod: 60, // Check for expired keys every minute
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
   * Clear the price cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    const size = this.priceCache.keys().length;
    this.priceCache.flushAll();
    this.logger.log(`Cleared price cache (${size} entries)`);
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): { size: number; hits: number; misses: number; keys: number } {
    const stats = this.priceCache.getStats();
    return {
      size: this.priceCache.keys().length,
      hits: stats.hits,
      misses: stats.misses,
      keys: stats.keys,
    };
  }
}
