import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import NodeCache from 'node-cache';

import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';

import { Charli3Client } from '@/modules/charli3/charli3.client';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { NexusClient } from '@/modules/nexus/nexus.client';
import { REDIS_CLIENT } from '@/modules/redis/redis.module';

/** Minimal VyFi pool shape needed for LP token resolution */
interface VyFiPoolRaw {
  'lpPolicyId-assetId'?: string;
  unitsPair?: string;
  poolValidatorUtxoAddress?: string; // Pool validator address
  orderValidatorUtxoAddress?: string; // Order validator address (used by DexHunter)
  tokenAQuantity?: number;
  tokenBQuantity?: number;
  lpQuantity?: number; // LP token total supply
  json?: string; // stringified VyFiPoolConfig
}

/** VyFiPoolConfig fields we need from pool.json */
// interface VyFiPoolConfigAsset {
//   currencySymbol: string;
//   tokenName: string;
// }

/** DexHunter /stats/pools/ADA response item */
export interface DexHunterPoolItem {
  dex_name: string;
  pool_id: string;
  /** ADA amount, example: "token_1_amount": 6763990.459555, */
  token_1_amount: number;
  /** Token amount, example: "token_2_amount": 905.383677, */
  token_2_amount: number;
  pool_fee: number;
}

/** Minswap API protocol types */
type MinswapProtocol = 'Minswap' | 'MinswapV2' | 'MinswapStable';

/** Minswap API asset metadata */
interface MinswapAssetMetadata {
  currency_symbol: string;
  token_name: string;
  is_verified: boolean;
  metadata?: {
    name: string;
    url: string;
    ticker: string;
    decimals: number;
    description: string;
  };
}

/** Minswap /v1/pools/metrics response - single pool metrics */
export interface MinswapPoolMetrics {
  lp_asset: MinswapAssetMetadata;
  type: MinswapProtocol;
  asset_a: MinswapAssetMetadata;
  asset_b: MinswapAssetMetadata;
  liquidity_raw: number;
  liquidity_a_raw: number;
  liquidity_b_raw: number;
  trading_fee_tier: number[];
  trading_fee_apr?: number;
  volume_24h: number;
  volume_7d: number;
  trading_fee_24h: number;
  trading_fee_7d: number;
  liquidity: number;
  liquidity_a: number;
  liquidity_b: number;
}

/** Minswap /v1/pools/metrics full response */
export interface MinswapPoolMetricsResponse {
  search_after?: string[];
  pool_metrics: MinswapPoolMetrics[];
}

/**
 * TapTools API client — now a thin wrapper that routes to Charli3 (primary) and Anvil/DexHunter.
 * All direct TapTools HTTP calls have been removed.
 */
@Injectable()
export class TapToolsClient {
  private readonly logger = new Logger(TapToolsClient.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;
  private readonly minswapBaseUrl: string;
  private readonly networkId: number; // 1 = mainnet, 0 = testnet (VyFi convention)

  /** Supply cache — 60 min TTL (total supply is immutable for most tokens) */
  private readonly supplyCache: NodeCache;

  /**
   * Valid OHLCV intervals supported by TapTools API
   */
  public readonly validOHLCVIntervals: readonly string[] = ['1h', '1d', '1w', '1M'];

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

  /**
   * Cache for market data (market cap, price changes)
   * TTL: 5 minutes (300 seconds) - market data changes frequently
   */
  private readonly marketDataCache: NodeCache;

  constructor(
    private readonly configService: ConfigService,
    private readonly charli3Client: Charli3Client,
    private readonly dexHunterPricingClient: DexHunterPricingClient,
    private readonly nexusClient: NexusClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL') || 'https://api.dexhunter.io';
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY') || '';
    this.minswapBaseUrl = 'https://api-mainnet-prod.minswap.org';
    this.networkId = this.isMainnet ? 1 : 0;

    this.supplyCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false });

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

    // Initialize market data cache with 5-minute TTL
    this.marketDataCache = new NodeCache({
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
    if (!this.isMainnet) {
      const resultMap = new Map<string, number | null>();
      tokenIds.forEach(tokenId => resultMap.set(tokenId, null));
      return resultMap;
    }

    const priceMap = new Map<string, number | null>();
    const tokensToFetch: string[] = [];

    tokenIds.forEach(tokenId => {
      const cacheKey = `token_price_${tokenId}`;
      const cached = this.priceCache.get<number | null>(cacheKey);
      if (cached !== undefined) {
        priceMap.set(tokenId, cached);
      } else {
        tokensToFetch.push(tokenId);
      }
    });

    if (tokensToFetch.length === 0) return priceMap;

    // Fetch from Charli3 (primary)
    await Promise.all(
      tokensToFetch.map(async tokenId => {
        try {
          const data = await this.charli3Client.getTokenMarketCap(tokenId);
          const price = data?.price > 0 ? data.price : null;
          priceMap.set(tokenId, price);
          this.priceCache.set(`token_price_${tokenId}`, price);
        } catch {
          priceMap.set(tokenId, null);
          this.priceCache.set(`token_price_${tokenId}`, null);
        }
      })
    );

    return priceMap;
  }

  /**
   * Get LP pools for a token.
   * Strategy: DexHunter for pool list → VyFi API for lpTokenUnit on VyFi pools
   *           → Minswap API for lpTokenUnit on Minswap pools.
   *
   * @param tokenUnit - Full token unit (policyId + assetName in hex)
   */
  async getTokenPools(tokenUnit: string): Promise<TapToolsTokenPoolDto[]> {
    if (!this.isMainnet) return [];

    // Use Redis cache with 10-minute TTL
    const cacheKey = `dexhunter:pools:${tokenUnit}`;

    try {
      // Check Redis cache first
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug(`Redis cache hit for pools: ${tokenUnit.slice(0, 10)}...`);
        return JSON.parse(cached);
      }
    } catch (redisError) {
      this.logger.warn(
        `Redis get failed for ${cacheKey}: ${redisError instanceof Error ? redisError.message : String(redisError)}`
      );
      // Continue with fetch on Redis error
    }

    try {
      // Step 1: Get all pools from DexHunter
      const dhResp = await fetch(`${this.dexHunterBaseUrl}/stats/pools/ADA/${tokenUnit}`, {
        headers: { 'X-Partner-Id': this.dexHunterApiKey, 'Content-Type': 'application/json' },
      });

      if (!dhResp.ok) {
        // Cache empty results in Redis for 2 minutes
        await this.redis.set(cacheKey, JSON.stringify([]), 'EX', 120).catch(() => {});
        return [];
      }

      const dhPools: DexHunterPoolItem[] = await dhResp.json();
      if (!dhPools || dhPools.length === 0) {
        // Cache empty results in Redis for 2 minutes
        await this.redis.set(cacheKey, JSON.stringify([]), 'EX', 120).catch(() => {});
        return [];
      }

      // Step 2: Pre-fetch VyFi pools for VyFi DEXs (Nexus returns empty lpUnit for VyFi)
      const hasVyFi = dhPools.some(p => p.dex_name.toLowerCase().includes('vyfi'));
      const vyfiPools = hasVyFi ? await this.fetchVyFiPoolsForToken(tokenUnit) : [];

      // Step 3: Map to TapToolsTokenPoolDto with LP token resolution and supply
      const result: TapToolsTokenPoolDto[] = await Promise.all(
        dhPools.map(async pool => {
          const dex = pool.dex_name.toLowerCase();
          let lpTokenUnit = '';
          let lpTotalSupply: number | null = null;

          if (dex.includes('vyfi') && vyfiPools.length > 0) {
            // VyFi pools: use VyFi API (Nexus returns empty lpUnit)
            const match = this.findVyFiPool(vyfiPools, pool.pool_id);
            if (match) {
              lpTokenUnit = this.extractVyFiLpTokenUnit(match);
              lpTotalSupply = match.lpQuantity ?? null;
            }
          } else {
            // Other DEXs: use Nexus API
            const nexusData = await this.fetchPoolDataFromNexus(pool.dex_name, pool.pool_id, tokenUnit);
            if (nexusData) {
              lpTokenUnit = nexusData.lpTokenUnit;
              lpTotalSupply = nexusData.lpTotalSupply;
            }
          }

          return {
            exchange: pool.dex_name,
            lpTokenUnit,
            onchainID: pool.pool_id,
            tokenA: tokenUnit,
            tokenALocked: pool.token_2_amount, // base token units
            tokenATicker: '',
            tokenB: '', // ADA
            tokenBLocked: pool.token_1_amount, // already in ADA from DexHunter API
            tokenBTicker: 'ADA',
            lpTotalSupply,
          };
        })
      );

      // Cache in Redis with 10-minute TTL (600 seconds)
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 600).catch(redisError => {
        this.logger.warn(
          `Redis set failed for ${cacheKey}: ${redisError instanceof Error ? redisError.message : String(redisError)}`
        );
      });

      return result;
    } catch (error) {
      this.logger.warn(
        `getTokenPools failed for ${tokenUnit.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      // Cache empty results in Redis for 2 minutes on error
      await this.redis.set(cacheKey, JSON.stringify([]), 'EX', 120).catch(() => {});
      return [];
    }
  }

  // ─── Pool resolution helpers ─────────────────────────────────────────────────

  /** Fetch VyFi pools for a tokenA/ADA pair */
  private async fetchVyFiPoolsForToken(tokenUnit: string): Promise<VyFiPoolRaw[]> {
    // VyFi is order-sensitive: try both tokenA=ADA/tokenB=token AND tokenA=token/tokenB=ADA
    const urls = [
      // Try ADA first (most common in VyFi API responses)
      `https://api-v3.vyfi.io/lp?networkId=${this.networkId}&tokenAUnit=lovelace&tokenBUnit=${tokenUnit}&v2=true`,
      // Try token first (fallback)
      `https://api-v3.vyfi.io/lp?networkId=${this.networkId}&tokenAUnit=${tokenUnit}&tokenBUnit=lovelace&v2=true`,
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data: unknown = await resp.json();
        if (Array.isArray(data) && data.length > 0) {
          // this.logger.debug(`Found ${data.length} VyFi pool(s) for token ${tokenUnit.slice(0, 10)}...`);
          return data as VyFiPoolRaw[];
        }
      } catch (err) {
        this.logger.debug(`VyFi API call failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return [];
  }

  /** Extract concatenated lpTokenUnit from VyFi pool "policyId-assetId" field */
  private extractVyFiLpTokenUnit(pool: VyFiPoolRaw): string {
    const parts = (pool['lpPolicyId-assetId'] ?? '').split('-');
    return parts.length === 2 ? `${parts[0]}${parts[1]}` : '';
  }

  /** Find the VyFi pool that matches DexHunter's pool_id (address) */
  private findVyFiPool(pools: VyFiPoolRaw[], poolId: string): VyFiPoolRaw | undefined {
    // DexHunter can return either poolValidatorUtxoAddress OR orderValidatorUtxoAddress
    return pools.find(p => p.poolValidatorUtxoAddress === poolId || p.orderValidatorUtxoAddress === poolId);
  }

  /**
   * Fetch LP token unit and total supply from Nexus API for non-VyFi pools
   * Falls back to Minswap API for Minswap pools if Nexus data is unavailable
   * @param dexName DEX name from DexHunter (e.g., "MINSWAPV2", "SUNDAESWAPV3")
   * @param poolId Pool ID from DexHunter (raw hash)
   * @param tokenUnit Full token unit for Minswap search fallback
   * @returns Object with lpTokenUnit and lpTotalSupply, or null if unavailable
   */
  private async fetchPoolDataFromNexus(
    dexName: string,
    poolId: string,
    tokenUnit?: string
  ): Promise<{ lpTokenUnit: string; lpTotalSupply: number | null } | null> {
    try {
      const nexusPoolId = this.normalizePoolId(dexName, poolId);
      const pool = await this.nexusClient.getPoolById(nexusPoolId);

      if (!pool || !pool.lpPolicyId || !pool.lpAssetName) {
        // Fallback to Minswap API for Minswap pools
        const isMinswap = dexName.toLowerCase().includes('minswap');
        if (isMinswap && tokenUnit) {
          // this.logger.debug(`Nexus data unavailable for Minswap pool ${poolId.slice(0, 8)}..., trying Minswap API`);
          return await this.fetchPoolDataFromMinswap(poolId, tokenUnit);
        }
        return null;
      }

      return {
        lpTokenUnit: `${pool.lpPolicyId}${pool.lpAssetName}`,
        lpTotalSupply: pool.lpTotalSupply ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch pool data from Nexus for ${dexName}/${poolId.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      // Fallback to Minswap API for Minswap pools
      const isMinswap = dexName.toLowerCase().includes('minswap');
      if (isMinswap && tokenUnit) {
        this.logger.debug(`Trying Minswap API fallback for pool ${poolId.slice(0, 8)}...`);
        return await this.fetchPoolDataFromMinswap(poolId, tokenUnit);
      }
      return null;
    }
  }

  /**
   * Fetch LP token unit and total supply from Minswap API
   * Used as fallback when Nexus API doesn't have pool data
   * Uses /v1/pools/metrics search endpoint since /v1/pools/{poolId} doesn't work reliably
   * @param poolId Pool ID hash from DexHunter
   * @param tokenUnit Full token unit (policyId + assetName) to search for
   * @returns Object with lpTokenUnit and lpTotalSupply, or null if unavailable
   */
  private async fetchPoolDataFromMinswap(
    poolId: string,
    tokenUnit: string
  ): Promise<{ lpTokenUnit: string; lpTotalSupply: number | null } | null> {
    try {
      // Extract policy ID (first 56 characters) for search
      const policyId = tokenUnit.slice(0, 56);

      const url = `${this.minswapBaseUrl}/v1/pools/metrics`;
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          term: policyId, // Search by token policy ID
          sort_field: 'liquidity',
          limit: 100, // Get enough results to find our pool
        }),
      });

      if (!response.ok) {
        this.logger.debug(`Minswap API returned ${response.status} for policy ${policyId.slice(0, 8)}...`);
        return null;
      }

      const data: MinswapPoolMetricsResponse = await response.json();
      const pools = data?.pool_metrics;

      if (!Array.isArray(pools) || pools.length === 0) {
        this.logger.debug(`Minswap API returned no pools for policy ${policyId.slice(0, 8)}...`);
        return null;
      }

      // Find the pool that matches our poolId
      // The LP token's token_name should match the poolId from DexHunter
      const matchingPool = pools.find(p => {
        const lpTokenName = p.lp_asset?.token_name;
        return lpTokenName === poolId;
      });

      if (!matchingPool?.lp_asset?.currency_symbol || !matchingPool?.lp_asset?.token_name) {
        this.logger.debug(`Could not find matching pool for poolId ${poolId.slice(0, 8)}... in Minswap results`);
        return null;
      }

      const lpTokenUnit = `${matchingPool.lp_asset.currency_symbol}${matchingPool.lp_asset.token_name}`;

      // Fetch LP total supply from BlockFrost since Minswap metrics endpoint doesn't provide it
      let lpTotalSupply: number | null = null;
      try {
        const asset = await this.blockfrost.assetsById(lpTokenUnit);
        lpTotalSupply = asset.quantity ? parseInt(asset.quantity, 10) : null;
      } catch (error) {
        this.logger.debug(
          `Failed to fetch LP total supply from BlockFrost for ${lpTokenUnit.slice(0, 16)}...: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      this.logger.log(
        `✅ Fetched LP token from Minswap API for pool ${poolId.slice(0, 8)}...: ${lpTokenUnit.slice(0, 16)}... (supply: ${lpTotalSupply ?? 'N/A'})`
      );

      return { lpTokenUnit, lpTotalSupply };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch pool data from Minswap API for ${poolId.slice(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Normalize DexHunter DEX name to Nexus pool ID format
   * @param dexName DEX name from DexHunter (e.g., "MINSWAPV2", "SUNDAESWAPV3")
   * @param poolId Pool ID hash from DexHunter
   * @returns Nexus-formatted pool ID (e.g., "minswap_v2_{hash}")
   */
  private normalizePoolId(dexName: string, poolId: string): string {
    const dexLower = dexName.toLowerCase();

    // Map DexHunter naming to Nexus format
    const dexMap: Record<string, string> = {
      minswapv1: 'minswap_v1',
      minswapv2: 'minswap_v2',
      sundaeswapv1: 'sundae_v1',
      sundaeswapv3: 'sundae_v3',
      wingriderv1: 'wingriders_v1', // Note: plural!
      wingriderv2: 'wingriders_v2', // Note: plural!
      muesliswap: 'muesli_v1',
      teddyswap: 'teddyswap',
      splash: 'splash',
      cswap: 'cswap',
      vyfi: 'vyfi',
    };

    const normalized = dexMap[dexLower] || dexLower;
    return `${normalized}_${poolId}`;
  }

  /**
   * Get pool data by onchain ID
   * Supports two ID formats:
   * 1. Nexus pool IDs (e.g., "minswap_v2_{hash}" or raw hash)
   * 2. VyFi unitsPair format (e.g., "lovelace:tokenUnit")
   *
   * @param onchainID - Pool onchain ID
   * @returns Pool data with LP token unit and total supply, or null if not found
   */
  async getPoolByOnchainId(onchainID: string): Promise<TapToolsTokenPoolDto | null> {
    if (!this.isMainnet) return null;

    const cacheKey = `pool_${onchainID}`;

    // Check Redis cache first
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (redisError) {
      this.logger.warn(
        `Redis get failed for ${cacheKey}: ${redisError instanceof Error ? redisError.message : String(redisError)}`
      );
      // Continue with fetch on Redis error
    }

    try {
      // Check if this is a VyFi unitsPair format (e.g., "lovelace:tokenUnit")
      if (onchainID.includes(':')) {
        const vyfiPool = await this.fetchVyFiPoolByUnitsPair(onchainID);
        if (vyfiPool) {
          // Cache in Redis with 10-minute TTL
          await this.redis.set(cacheKey, JSON.stringify(vyfiPool), 'EX', 600).catch(() => {});
          return vyfiPool;
        }
      }

      // Otherwise, try fetching from Nexus API directly
      const pool = await this.nexusClient.getPoolById(onchainID);

      if (!pool) {
        // Cache null result in Redis for 2 minutes
        await this.redis.set(cacheKey, JSON.stringify(null), 'EX', 120).catch(() => {});
        return null;
      }

      // Convert Nexus pool to TapToolsTokenPoolDto format
      const result: TapToolsTokenPoolDto = {
        exchange: pool.dex || 'unknown',
        lpTokenUnit: `${pool.lpPolicyId}${pool.lpAssetName}`,
        onchainID: pool.poolId,
        tokenA: `${pool.tokenAPolicyId}${pool.tokenAAssetName}`,
        tokenALocked: pool.tokenAReserve,
        tokenATicker: '',
        tokenB: pool.tokenBPolicyId === '' ? '' : `${pool.tokenBPolicyId}${pool.tokenBAssetName}`,
        tokenBLocked: pool.tokenBReserve,
        tokenBTicker: pool.tokenBPolicyId === '' ? 'ADA' : '',
        lpTotalSupply: pool.lpTotalSupply ?? null,
      };

      // Cache in Redis with 10-minute TTL
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 600).catch(() => {});
      return result;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch pool by onchainID ${onchainID.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      // Cache null result in Redis for 2 minutes on error
      await this.redis.set(cacheKey, JSON.stringify(null), 'EX', 120).catch(() => {});
      return null;
    }
  }

  /**
   * Fetch VyFi pool by unitsPair (e.g., "lovelace:tokenUnit")
   * @param unitsPair VyFi pool identifier in format "tokenA:tokenB"
   * @returns Pool data or null if not found
   */
  private async fetchVyFiPoolByUnitsPair(unitsPair: string): Promise<TapToolsTokenPoolDto | null> {
    try {
      // Parse unitsPair format:
      // - "lovelace:tokenUnit" (explicit ADA first)
      // - "tokenUnit:lovelace" (explicit ADA second)
      // - ":tokenUnit" (implicit ADA first - empty string = lovelace)
      // - "tokenUnit:" (implicit ADA second - empty string = lovelace)
      const parts = unitsPair.split(':');

      if (parts.length !== 2) {
        this.logger.warn(`Invalid unitsPair format (must contain exactly one colon): ${unitsPair}`);
        return null;
      }

      const [tokenA, tokenB] = parts;

      // Determine which token is ADA (lovelace can be explicit or implicit via empty string)
      const isTokenALovelace = tokenA === 'lovelace' || tokenA === '';
      const isTokenBLovelace = tokenB === 'lovelace' || tokenB === '';

      // One side must be lovelace/empty (ADA)
      if (!isTokenALovelace && !isTokenBLovelace) {
        this.logger.warn(`Invalid unitsPair: neither side is ADA/lovelace: ${unitsPair}`);
        return null;
      }

      // Extract the asset token (the non-ADA side)
      const assetTokenUnit = isTokenALovelace ? tokenB : tokenA;

      if (!assetTokenUnit) {
        this.logger.warn(`Invalid unitsPair: asset token is empty: ${unitsPair}`);
        return null;
      }

      // Query VyFi API (order matters: tokenAUnit is typically ADA)
      const url = `https://api-v3.vyfi.io/lp?networkId=${this.networkId}&tokenAUnit=lovelace&tokenBUnit=${assetTokenUnit}&v2=true`;
      const resp = await fetch(url);

      if (!resp.ok) {
        this.logger.debug(`VyFi API returned ${resp.status} for unitsPair ${unitsPair}`);
        return null;
      }

      const pools: VyFiPoolRaw[] = await resp.json();

      // Find the pool with matching unitsPair (VyFi responses may normalize to ADA-first order)
      const candidates = new Set([
        unitsPair,
        `${tokenB}:${tokenA}`,
        `lovelace:${assetTokenUnit}`,
        `${assetTokenUnit}:lovelace`,
      ]);
      const pool = pools.find(p => p.unitsPair && candidates.has(p.unitsPair));

      if (!pool) {
        this.logger.debug(`No VyFi pool found with unitsPair: ${unitsPair}`);
        return null;
      }

      // Convert to TapToolsTokenPoolDto format
      return {
        exchange: 'VyFi',
        lpTokenUnit: this.extractVyFiLpTokenUnit(pool),
        onchainID: unitsPair, // Use unitsPair as the canonical ID
        tokenA: isTokenALovelace ? '' : assetTokenUnit, // Empty string for ADA
        tokenALocked: isTokenALovelace ? (pool.tokenAQuantity ?? 0) : (pool.tokenBQuantity ?? 0),
        tokenATicker: isTokenALovelace ? 'ADA' : '',
        tokenB: isTokenALovelace ? assetTokenUnit : '',
        tokenBLocked: isTokenALovelace ? (pool.tokenBQuantity ?? 0) : (pool.tokenAQuantity ?? 0),
        tokenBTicker: isTokenALovelace ? '' : 'ADA',
        lpTotalSupply: pool.lpQuantity ?? null,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch VyFi pool by unitsPair ${unitsPair}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Get OHLCV (Open, High, Low, Close, Volume) data for a token
   * Fetches historical price data from TapTools API
   *
   * @param scriptHash - Token policy ID (script hash)
   * @param assetName - Token asset name in hex
   * @param interval - Time interval ('1h', '1d', '1w', '1M')
   * @param numIntervals - Optional number of intervals to return (omit for full history)
   * @returns OHLCV data array or null if unavailable
   */
  async getTokenOHLCV(
    scriptHash: string,
    assetName: string,
    interval: string,
    numIntervals?: number
  ): Promise<MarketOhlcvSeries | null> {
    if (!this.isMainnet) return null;

    if (!this.validOHLCVIntervals.includes(interval)) {
      this.logger.warn(`Invalid interval '${interval}'. Valid intervals: ${this.validOHLCVIntervals.join(', ')}`);
      return null;
    }

    const cacheKey = numIntervals
      ? `ohlcv_${scriptHash}_${assetName}_${interval}_${numIntervals}`
      : `ohlcv_${scriptHash}_${assetName}_${interval}`;

    const cached = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);
    if (cached !== undefined) return cached;

    const unit = `${scriptHash}${assetName}`;

    // PRIMARY: Charli3
    try {
      const charli3Data = await this.charli3Client.getTokenOHLCV(unit, interval, numIntervals);
      if (charli3Data && charli3Data.length > 0) {
        this.ohlcvCache.set(cacheKey, charli3Data);
        return charli3Data;
      }
    } catch {
      this.logger.debug(`Charli3 OHLCV failed for ${unit.slice(0, 10)}...`);
    }

    return null;
  }

  /**
   * Fetch token total supply and decimals from Blockfrost.
   * Cached 60 min — supply is immutable for most Cardano tokens.
   */
  async getTokenSupply(unit: string): Promise<{ totalSupply: number; decimals: number } | null> {
    const cacheKey = `supply_${unit}`;
    const cached = this.supplyCache.get<{ totalSupply: number; decimals: number }>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const asset = await this.blockfrost.assetsById(unit);
      const decimals = asset?.metadata?.decimals ?? 0;

      const quantity = BigInt(asset.quantity);
      const divisor = BigInt(10) ** BigInt(decimals);
      const maxSafeQuantity = BigInt(Number.MAX_SAFE_INTEGER) * divisor;

      if (quantity > maxSafeQuantity) {
        this.logger.debug(`Blockfrost supply for ${unit.slice(0, 10)}... exceeds JS safe integer range`);
        return null;
      }

      const totalSupply = Number(quantity) / Number(divisor);
      const result = { totalSupply, decimals };
      this.supplyCache.set(cacheKey, result);
      return result;
    } catch {
      this.logger.debug(`Blockfrost supply lookup failed for ${unit.slice(0, 10)}...`);
      return null;
    }
  }

  /**
   * Get market cap data for a token.
   * Charli3 is the PRIMARY source for price.
   * Supply is fetched from Blockfrost and FDV is computed as price * totalSupply (when supply is available).
   * @param unit - Token unit (policyId + assetName in hex)
   * @returns Market cap data or null if unavailable
   */
  async getTokenMarketCap(unit: string): Promise<{
    price: number;
    fdv: number;
    circSupply: number;
    mcap: number;
    totalSupply: number;
  } | null> {
    if (!this.isMainnet) {
      this.logger.debug(`Skipping market cap API call for non-mainnet environment`);
      return null;
    }

    const cacheKey = `mcap_${unit}`;
    const cached = this.marketDataCache.get<{
      price: number;
      fdv: number;
      circSupply: number;
      mcap: number;
      totalSupply: number;
    }>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // PRIMARY: Charli3 price + Blockfrost supply → compute fdv/mcap
    try {
      const charli3Data = await this.charli3Client.getTokenMarketCap(unit);
      if (charli3Data && charli3Data.price > 0) {
        this.logger.debug(`Charli3 price for ${unit.slice(0, 10)}...: ${charli3Data.price} ADA`);

        // Enrich with supply data from Blockfrost
        const supplyData = await this.getTokenSupply(unit);
        const totalSupply = supplyData?.totalSupply ?? 0;
        const fdv = totalSupply > 0 ? charli3Data.price * totalSupply : 0;
        const result = {
          price: charli3Data.price,
          fdv,
          circSupply: 0,
          mcap: 0,
          totalSupply,
        };
        this.marketDataCache.set(cacheKey, result);
        return result;
      }
    } catch {
      this.logger.debug(`Charli3 market cap failed for ${unit.slice(0, 10)}...`);
    }

    return null;
  }

  /**
   * Get price changes for a token.
   * Charli3 is the PRIMARY source (calculates all timeframes from OHLCV including 7d/30d).
   * Falls back to DexHunter OHLCV (daily candles) when Charli3 has no data.
   * Note: the 1h timeframe is approximate in the DexHunter fallback path (daily resolution).
   *
   * @param unit - Token unit (policyId + assetName in hex)
   * @param timeframes - Comma-separated timeframes (e.g., '1h,24h,7d,30d')
   * @returns Object with timeframe keys and percentage change values, or null if unavailable
   */
  async getTokenPriceChanges(
    unit: string,
    timeframes: string = '1h,24h,7d,30d'
  ): Promise<Record<string, number> | null> {
    if (!this.isMainnet) {
      this.logger.debug(`Skipping price changes API call for non-mainnet environment`);
      return null;
    }

    const cacheKey = `price_chg_${unit}_${timeframes}`;
    const cached = this.marketDataCache.get<Record<string, number>>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // PRIMARY: Charli3 — calculates from OHLCV, supports all timeframes including 7d/30d
    try {
      const charli3Data = await this.charli3Client.getTokenPriceChanges(unit, timeframes);
      if (charli3Data) {
        this.logger.debug(
          `Charli3 price changes for ${unit.slice(0, 10)}...: 1h=${charli3Data['1h']?.toFixed(2)}% 24h=${charli3Data['24h']?.toFixed(2)}% 7d=${charli3Data['7d']?.toFixed(2)}% 30d=${charli3Data['30d']?.toFixed(2)}%`
        );
        this.marketDataCache.set(cacheKey, charli3Data);
        return charli3Data;
      }
    } catch {
      this.logger.debug(`Charli3 price changes failed for ${unit.slice(0, 10)}...`);
    }

    // FALLBACK: DexHunter OHLCV — fetch 31 daily candles, compute changes from close prices
    try {
      const scriptHash = unit.slice(0, 56);
      const assetName = unit.slice(56);
      const ohlcv = await this.dexHunterPricingClient.getTokenOHLCV(scriptHash, assetName, '1d', 31);
      if (ohlcv && ohlcv.length > 0) {
        const changes = this.calculatePriceChangesFromOHLCV(ohlcv, timeframes);
        if (changes) {
          this.logger.debug(`DexHunter OHLCV price changes for ${unit.slice(0, 10)}...`);
          this.marketDataCache.set(cacheKey, changes);
          return changes;
        }
      }
    } catch {
      this.logger.debug(`DexHunter price changes fallback failed for ${unit.slice(0, 10)}...`);
    }

    return null;
  }

  /**
   * Calculate price change percentages from an OHLCV series.
   * Uses close prices and walks back from now by each timeframe's seconds.
   */
  private calculatePriceChangesFromOHLCV(series: MarketOhlcvSeries, timeframes: string): Record<string, number> | null {
    if (!series.length) return null;

    const TIMEFRAME_SECONDS: Record<string, number> = {
      '1h': 3600,
      '24h': 86400,
      '7d': 7 * 86400,
      '30d': 30 * 86400,
    };

    const now = Math.floor(Date.now() / 1000);
    const currentPrice = series[series.length - 1].close;
    if (!currentPrice) return null;

    const frames = timeframes.split(',').map(t => t.trim());
    const result: Record<string, number> = {};

    for (const tf of frames) {
      const secondsBack = TIMEFRAME_SECONDS[tf];
      if (!secondsBack) {
        result[tf] = 0;
        continue;
      }
      const targetTs = now - secondsBack;
      let oldPrice = series[0].close;
      for (const point of series) {
        if (point.time <= targetTs) oldPrice = point.close;
        else break;
      }
      result[tf] = oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : 0;
    }

    return result;
  }

  /**
   * Clear all caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    const priceSize = this.priceCache.keys().length;
    const ohlcvSize = this.ohlcvCache.keys().length;
    const marketDataSize = this.marketDataCache.keys().length;
    const supplySize = this.supplyCache.keys().length;
    this.priceCache.flushAll();
    this.ohlcvCache.flushAll();
    this.marketDataCache.flushAll();
    this.supplyCache.flushAll();
    this.logger.log(
      `Cleared caches - price: ${priceSize}, ohlcv: ${ohlcvSize}, ` +
        `marketData: ${marketDataSize}, supply: ${supplySize} entries (pool cache uses Redis)`
    );
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    price: { size: number; hits: number; misses: number; keys: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
    marketData: { size: number; hits: number; misses: number; keys: number };
  } {
    const priceStats = this.priceCache.getStats();
    const ohlcvStats = this.ohlcvCache.getStats();
    const marketDataStats = this.marketDataCache.getStats();
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
      marketData: {
        size: this.marketDataCache.keys().length,
        hits: marketDataStats.hits,
        misses: marketDataStats.misses,
        keys: marketDataStats.keys,
      },
    };
  }
}
