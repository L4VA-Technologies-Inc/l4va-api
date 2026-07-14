import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

import { DexHunterPoolItem, TapToolsClient } from '../taptools/taptools.client';

import { DexHunterPricingClient, VyFiPoolCacheEntry } from './dexhunter-pricing.client';

import { REDIS_CLIENT } from '@/modules/redis/redis.module';

/**
 * DexHunter Pricing Service - Orchestrates token pricing from multiple sources
 *
 * Pricing Strategy (VyFi-first with multi-source fallback):
 * 1. Check Redis cache (populated by VyFi bulk refresh every 10 minutes)
 * 2. If cache miss, try DexHunter API for individual token
 * 3. If DexHunter fails, try TapTools (Charli3) as last resort
 * 4. Return null only if all sources fail
 *
 * VyFi bulk pricing: ~500 tokens cached in Redis, refreshed by background cron task
 * This provides fast lookups for most tokens without per-token API calls.
 *
 * Build Swap Flow:
 * 1. Estimate Swap - Get price quote and fee breakdown
 * 2. Build Swap Transaction - Get unsigned transaction CBOR from DexHunter | /swap/build
 * 3. Sign Transaction - Sign with treasury wallet private key
 * 4. Submit Transaction - Submit signed transaction to blockchain | /swap/sign
 *
 * @see https://docs.dexhunter.io for complete DexHunter API documentation
 */
@Injectable()
export class DexHunterPricingService {
  private readonly logger = new Logger(DexHunterPricingService.name);
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;
  private readonly isMainnet: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly dexHunterClient: DexHunterPricingClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Fetch all VyFi token prices and pool data in a single request
   * Uses the combined fetchmaster endpoint: ?data=allPools,allTokenPricesMap
   * Response shape: { allPools: [{},{},...], allTokenPricesMap: {...} }
   */
  private async fetchVyFiMasterData(): Promise<{
    pricesMap: Map<string, number> | null;
    poolsMap: Map<string, VyFiPoolCacheEntry> | null;
  }> {
    try {
      const response = await fetch('https://api-v3.vyfi.io/fetchmaster?data=allPools,allTokenPricesMap', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorText = await response.text();
        const sanitizedError = this.sanitizeErrorText(errorText, response.status);
        if (response.status === 502) {
          this.logger.warn(`VyFi fetchmaster temporarily unavailable (${response.status}): ${sanitizedError}`);
        } else {
          this.logger.error(`VyFi fetchmaster error (${response.status}): ${sanitizedError}`);
        }
        return { pricesMap: null, poolsMap: null };
      }

      const data = await response.json();

      // --- Parse allTokenPricesMap ---
      let pricesMap: Map<string, number> | null = null;
      const rawPrices = data.allTokenPricesMap;

      if (rawPrices && typeof rawPrices === 'object') {
        pricesMap = new Map<string, number>();
        let validCount = 0;

        for (const [key, value] of Object.entries(rawPrices)) {
          // Key format: "policyId-assetId" → tokenUnit: "policyIdassetId"
          const tokenUnit = key.replace('-', '');
          const priceData = value as any;
          let price: number | null = null;

          // Format 1 (LP tokens): { priceADA: number }
          if (priceData.priceADA && typeof priceData.priceADA === 'number' && priceData.priceADA > 0) {
            price = priceData.priceADA;
          }
          // Format 2 (regular tokens): { lpRatio: { "lovelace/tokenUnit": { priceRatioAB: number } } }
          else if (priceData.lpRatio && typeof priceData.lpRatio === 'object') {
            for (const [poolPair, ratioData] of Object.entries(priceData.lpRatio)) {
              if (poolPair.startsWith('lovelace/') && (ratioData as any).priceRatioAB) {
                const priceRatioAB = (ratioData as any).priceRatioAB;
                if (typeof priceRatioAB === 'number' && priceRatioAB > 0) {
                  price = priceRatioAB;
                  break;
                }
              }
            }
          }

          if (price !== null) {
            pricesMap.set(tokenUnit, price);
            validCount++;
          }
        }

        this.logger.log(`VyFi fetchmaster: ${validCount} token prices retrieved`);
      } else {
        this.logger.error('VyFi fetchmaster returned invalid allTokenPricesMap structure');
      }

      // --- Parse allPools ---
      let poolsMap: Map<string, VyFiPoolCacheEntry> | null = null;
      const rawPools = data.allPools;

      if (Array.isArray(rawPools)) {
        poolsMap = new Map<string, VyFiPoolCacheEntry>();

        for (const pool of rawPools) {
          try {
            const unitsPair: string = pool.unitsPair;
            if (!unitsPair) continue;

            // Extract LP token unit from "policyId-assetId" — policyId is always 56 hex chars
            const lpRaw: string = pool['lpPolicyId-assetId'] ?? '';
            const dashIdx = lpRaw.indexOf('-');
            const lpTokenUnit = dashIdx === 56 ? lpRaw.slice(0, 56) + lpRaw.slice(57) : lpRaw.replace('-', '');

            poolsMap.set(unitsPair, {
              unitsPair,
              lpTokenUnit,
              lpTokenTotalSupply: pool.lpTokenTotalSupply ?? 0,
              tvl: pool.tvl ?? 0,
              tokenAUnit: pool.tokenA?.unit ?? 'lovelace',
              tokenADecimals: pool.tokenA?.decimals ?? 6,
              tokenBUnit: pool.tokenB?.unit ?? '',
              tokenBDecimals: pool.tokenB?.decimals ?? 0,
              poolAddress: pool.poolValidatorUtxoAddress ?? '',
              orderAddress: pool.orderValidatorUtxoAddress ?? '',
            });
          } catch {
            // Skip malformed pool entries silently
          }
        }

        this.logger.log(`VyFi fetchmaster: ${poolsMap.size} pools retrieved`);
      } else {
        this.logger.error('VyFi fetchmaster returned unexpected allPools structure (expected array)');
      }

      return { pricesMap, poolsMap };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`VyFi fetchmaster failed: ${errorMessage}`);
      return { pricesMap: null, poolsMap: null };
    }
  }

  async refreshVyFiCache(): Promise<number | null> {
    if (!this.isMainnet) {
      this.logger.debug('Skipping VyFi cache refresh for non-mainnet environment');
      return null;
    }

    // Acquire distributed lock to prevent duplicate refresh across multiple instances
    const lockKey = 'lock:vyfi-price-refresh';
    const lock = await this.redis.set(lockKey, '1', 'EX', 540, 'NX');
    if (!lock) {
      this.logger.debug('Skipping VyFi refresh because another instance is already refreshing');
      return null;
    }

    const { pricesMap, poolsMap } = await this.fetchVyFiMasterData();

    if (!pricesMap || pricesMap.size === 0) {
      this.logger.warn('VyFi fetchmaster returned no prices');
      return null;
    }

    // Store prices and pool data in Redis (pool failures don't block price updates)
    await this.dexHunterClient.setRedisPrices(pricesMap);

    if (poolsMap && poolsMap.size > 0) {
      await this.dexHunterClient.setRedisPoolData(poolsMap);
    }

    return pricesMap.size;
  }

  /**
   * Get cached VyFi pool data from Redis
   * Populated by the 10-minute fetchmaster cron via refreshVyFiCache()
   * @param tokenAUnit - First token unit (e.g. "lovelace")
   * @param tokenBUnit - Second token unit (hex)
   * @returns Cached pool entry or null if not in cache
   */
  async getVyFiPoolFromCache(tokenAUnit: string, tokenBUnit: string): Promise<VyFiPoolCacheEntry | null> {
    return this.dexHunterClient.getRedisPoolData(`${tokenAUnit}/${tokenBUnit}`);
  }

  /**
   * Sanitize error response text - detect HTML error pages and extract concise error info
   * Prevents massive HTML dumps in logs when external APIs return error pages
   * Used by checkTokenLiquidity method for DexHunter pool aggregation endpoint
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
   * Get current token price in ADA.
   * Strategy: VyFi Redis cache → DexHunter API → TapTools (Charli3) → null
   *
   * @param tokenId - The token identifier (policyId + assetName in hex)
   * @returns Token price in ADA, or null if not found
   */
  async getTokenPrice(tokenId: string): Promise<number | null> {
    // 1. Check VyFi Redis cache first
    const cachedPrice = await this.dexHunterClient.getRedisPrice(tokenId);
    if (cachedPrice !== null && cachedPrice > 0) {
      return cachedPrice;
    }

    // 2. Fallback: DexHunter API
    const dexHunterResult = await this.dexHunterClient.getTokenPrices([tokenId]);
    const dexHunterPrice = dexHunterResult.get(tokenId);

    if (dexHunterPrice !== null && dexHunterPrice !== undefined && dexHunterPrice > 0) {
      return dexHunterPrice;
    }

    // 3. Last resort: TapTools (Charli3)
    this.logger.debug(`DexHunter returned no price for ${tokenId.slice(0, 10)}..., trying TapTools`);
    const tapToolsResult = await this.tapToolsClient.getTokenPrices([tokenId]);
    const tapToolsPrice = tapToolsResult.get(tokenId);

    if (tapToolsPrice !== null && tapToolsPrice !== undefined && tapToolsPrice > 0) {
      this.logger.debug(`TapTools price for ${tokenId.slice(0, 10)}...: ${tapToolsPrice} ADA`);
      return tapToolsPrice;
    }

    this.logger.debug(`No price available from any source for ${tokenId.slice(0, 10)}...`);
    return null;
  }

  /**
   * Get prices for multiple tokens in ADA.
   * Strategy: VyFi Redis cache → DexHunter API batch → TapTools batch → null
   *
   * @param tokenIds - Array of token identifiers
   * @returns Map of tokenId to price in ADA (null if not found)
   */
  async getTokenPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    // 1. Check VyFi Redis cache first (batch operation)
    const cachedResults = await this.dexHunterClient.getRedisPrices(tokenIds);
    const tokensNeedingFallback: string[] = [];

    cachedResults.forEach((price, tokenId) => {
      if (price === null || price === undefined) {
        tokensNeedingFallback.push(tokenId);
      }
    });

    // If all tokens found in cache, return early
    if (tokensNeedingFallback.length === 0) {
      return cachedResults;
    }

    this.logger.debug(`${tokensNeedingFallback.length}/${tokenIds.length} tokens cache miss, trying DexHunter API`);

    // 2. Fallback: DexHunter API for cache misses
    const dexHunterResults = await this.dexHunterClient.getTokenPrices(tokensNeedingFallback);
    const tokensStillMissing: string[] = [];

    dexHunterResults.forEach((price, tokenId) => {
      if (price !== null && price !== undefined && price > 0) {
        cachedResults.set(tokenId, price);
      } else {
        tokensStillMissing.push(tokenId);
      }
    });

    // 3. Last resort: TapTools (Charli3) for remaining misses
    if (tokensStillMissing.length > 0) {
      this.logger.debug(`${tokensStillMissing.length}/${tokenIds.length} tokens still missing, trying TapTools`);
      const tapToolsResults = await this.tapToolsClient.getTokenPrices(tokensStillMissing);
      tapToolsResults.forEach((price, tokenId) => {
        if (price !== null && price !== undefined && price > 0) {
          cachedResults.set(tokenId, price);
        }
      });
    }

    return cachedResults;
  }

  /**
   * Check if token has liquidity pools across ALL DEXes
   * Returns aggregated pool data from MinSwap, VyFi, SundaeSwap, Spectrum, etc.
   *
   * Note: This method uses DexHunter's pool aggregation endpoint (/stats/pools) directly,
   * not the pricing clients. DexHunter is currently the only source for multi-DEX pool aggregation.
   *
   * This is superior to checking individual DEX APIs because:
   * - Community can create LP on ANY DEX, not just VyFi
   * - Returns total liquidity across entire ecosystem
   * - Better price discovery from multiple sources
   *
   * @param tokenId - The token identifier (policyId + assetName in hex)
   * @returns Pool statistics if liquidity exists, null otherwise
   */
  async checkTokenLiquidity(tokenId: string): Promise<{
    hasLiquidity: boolean;
    totalAdaLiquidity: number;
    pools: Array<{
      dex: string;
      adaAmount: number;
      tokenAmount: number;
      poolId: string;
      fee: number;
    }>;
  } | null> {
    // Skip API calls for testnet
    if (!this.isMainnet) {
      this.logger.debug(`Skipping DexHunter liquidity check for testnet token ${tokenId}`);
      return null;
    }

    try {
      const response = await fetch(`${this.dexHunterBaseUrl}/stats/pools/ADA/${tokenId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Id': this.dexHunterApiKey,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug(`No liquidity pools found for token ${tokenId}`);
          return {
            hasLiquidity: false,
            totalAdaLiquidity: 0,
            pools: [],
          };
        }
        const errorText = await response.text();
        const sanitizedError = this.sanitizeErrorText(errorText, response.status);
        throw new Error(`DexHunter API error: ${response.status} - ${sanitizedError}`);
      }

      const data: Array<DexHunterPoolItem> = await response.json();

      if (!data || data.length === 0) {
        return {
          hasLiquidity: false,
          totalAdaLiquidity: 0,
          pools: [],
        };
      }

      // Calculate total ADA liquidity across all DEXes
      const totalAdaLiquidity = data.reduce((sum, pool) => sum + (pool.token_1_amount || 0), 0);

      const pools = data.map(pool => ({
        dex: pool.dex_name,
        adaAmount: pool.token_1_amount || 0,
        tokenAmount: pool.token_2_amount || 0,
        poolId: pool.pool_id,
        fee: pool.pool_fee,
      }));

      this.logger.debug(
        `Token ${tokenId.slice(0, 6)}...${tokenId.slice(-6)} has liquidity across ${pools.length} DEX(es): ` +
          `${pools.map(p => `${p.dex} (${p.adaAmount.toFixed(2)} ADA)`).join(', ')}`
      );

      return {
        hasLiquidity: totalAdaLiquidity > 0,
        totalAdaLiquidity,
        pools,
      };
    } catch (error) {
      this.logger.error(`Failed to check token liquidity for ${tokenId}`, error);
      return null;
    }
  }
}
