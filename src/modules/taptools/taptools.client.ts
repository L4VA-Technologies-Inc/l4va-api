import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';

import { Charli3Client } from '@/modules/charli3/charli3.client';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { NexusClient } from '@/modules/nexus/nexus.client';

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
   * Cache for token pool results
   * TTL: 10 minutes (600 seconds) - LP pool data doesn't change frequently
   */
  private readonly poolCache: NodeCache;

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
    private readonly nexusClient: NexusClient
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL') || 'https://api.dexhunter.io';
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY') || '';
    this.networkId = this.isMainnet ? 1 : 0;

    this.supplyCache = new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false });

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
    const cacheKey = `tokenUnit_${tokenUnit}`;
    const cached = this.poolCache.get<TapToolsTokenPoolDto[]>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      // Step 1: Get all pools from DexHunter
      const dhResp = await fetch(`${this.dexHunterBaseUrl}/stats/pools/ADA/${tokenUnit}`, {
        headers: { 'X-Partner-Id': this.dexHunterApiKey, 'Content-Type': 'application/json' },
      });

      if (!dhResp.ok) {
        this.poolCache.set(cacheKey, []);
        return [];
      }

      const dhPools: DexHunterPoolItem[] = await dhResp.json();
      if (!dhPools || dhPools.length === 0) {
        this.poolCache.set(cacheKey, []);
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
            const nexusData = await this.fetchPoolDataFromNexus(pool.dex_name, pool.pool_id);
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

      this.poolCache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.warn(
        `getTokenPools failed for ${tokenUnit.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      this.poolCache.set(cacheKey, []);
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
          this.logger.debug(`Found ${data.length} VyFi pool(s) for token ${tokenUnit.slice(0, 10)}...`);
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
   * @param dexName DEX name from DexHunter (e.g., "MINSWAPV2", "SUNDAESWAPV3")
   * @param poolId Pool ID from DexHunter (raw hash)
   * @returns Object with lpTokenUnit and lpTotalSupply, or null if unavailable
   */
  private async fetchPoolDataFromNexus(
    dexName: string,
    poolId: string
  ): Promise<{ lpTokenUnit: string; lpTotalSupply: number | null } | null> {
    try {
      const nexusPoolId = this.normalizePoolId(dexName, poolId);
      const pool = await this.nexusClient.getPoolById(nexusPoolId);

      if (!pool || !pool.lpPolicyId || !pool.lpAssetName) {
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
    const cached = this.poolCache.get<TapToolsTokenPoolDto | null>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      // Check if this is a VyFi unitsPair format (e.g., "lovelace:tokenUnit")
      if (onchainID.includes(':')) {
        const vyfiPool = await this.fetchVyFiPoolByUnitsPair(onchainID);
        if (vyfiPool) {
          this.poolCache.set(cacheKey, vyfiPool);
          return vyfiPool;
        }
      }

      // Otherwise, try fetching from Nexus API directly
      const pool = await this.nexusClient.getPoolById(onchainID);

      if (!pool) {
        this.poolCache.set(cacheKey, null);
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

      this.poolCache.set(cacheKey, result);
      return result;
    } catch (error) {
      this.logger.warn(
        `Failed to fetch pool by onchainID ${onchainID.slice(0, 10)}...: ${error instanceof Error ? error.message : String(error)}`
      );
      this.poolCache.set(cacheKey, null);
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
      // Parse unitsPair format: "lovelace:tokenUnit" or "tokenUnit:lovelace"
      const [tokenA, tokenB] = unitsPair.split(':');

      if (!tokenA || !tokenB) {
        this.logger.warn(`Invalid unitsPair format: ${unitsPair}`);
        return null;
      }

      // Determine which token is ADA (lovelace) and which is the asset
      const isTokenALovelace = tokenA === 'lovelace';
      const assetTokenUnit = isTokenALovelace ? tokenB : tokenA;

      // Query VyFi API (order matters: tokenAUnit is typically ADA)
      const url = `https://api-v3.vyfi.io/lp?networkId=${this.networkId}&tokenAUnit=lovelace&tokenBUnit=${assetTokenUnit}&v2=true`;
      const resp = await fetch(url);

      if (!resp.ok) {
        this.logger.debug(`VyFi API returned ${resp.status} for unitsPair ${unitsPair}`);
        return null;
      }

      const pools: VyFiPoolRaw[] = await resp.json();

      // Find the pool with matching unitsPair
      const pool = pools.find(p => p.unitsPair === unitsPair);

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
    const poolSize = this.poolCache.keys().length;
    const ohlcvSize = this.ohlcvCache.keys().length;
    const marketDataSize = this.marketDataCache.keys().length;
    const supplySize = this.supplyCache.keys().length;
    this.priceCache.flushAll();
    this.poolCache.flushAll();
    this.ohlcvCache.flushAll();
    this.marketDataCache.flushAll();
    this.supplyCache.flushAll();
    this.logger.log(
      `Cleared caches - price: ${priceSize}, pool: ${poolSize}, ohlcv: ${ohlcvSize}, ` +
        `marketData: ${marketDataSize}, supply: ${supplySize} entries`
    );
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    price: { size: number; hits: number; misses: number; keys: number };
    pool: { size: number; hits: number; misses: number; keys: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
    marketData: { size: number; hits: number; misses: number; keys: number };
  } {
    const priceStats = this.priceCache.getStats();
    const poolStats = this.poolCache.getStats();
    const ohlcvStats = this.ohlcvCache.getStats();
    const marketDataStats = this.marketDataCache.getStats();
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
