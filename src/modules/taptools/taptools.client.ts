import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';

import { AnvilClient } from '@/modules/anvil/anvil.client';
import { Charli3Client } from '@/modules/charli3/charli3.client';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';

/** Minimal VyFi pool shape needed for LP token resolution */
interface VyFiPoolRaw {
  'lpPolicyId-assetId'?: string;
  unitsPair?: string;
  tokenAQuantity?: number;
  tokenBQuantity?: number;
  json?: string; // stringified VyFiPoolConfig
}

/** VyFiPoolConfig fields we need from pool.json */
interface VyFiPoolConfigAsset {
  currencySymbol: string;
  tokenName: string;
}

/** Minimal Minswap pool metrics shape */
interface MinswapPoolMetrics {
  id?: string; // LP asset = policyId + tokenName
  assetA?: { policyId?: string; assetName?: string };
  assetB?: { policyId?: string; assetName?: string };
  reserveA?: string;
  reserveB?: string;
}

/** DexHunter /stats/pools/ADA response item */
interface DexHunterPoolItem {
  dex_name: string;
  pool_id: string;
  token_1_amount: number; // ADA in lovelace
  token_2_amount: number; // token in base units
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
   * Cache for NFT collection trait prices
   * TTL: 10 minutes (600 seconds) - trait prices don't change frequently
   */
  private readonly traitPricesCache: NodeCache;

  /**
   * Cache for market data (market cap, price changes)
   * TTL: 5 minutes (300 seconds) - market data changes frequently
   */
  private readonly marketDataCache: NodeCache;

  constructor(
    private readonly configService: ConfigService,
    private readonly charli3Client: Charli3Client,
    private readonly anvilClient: AnvilClient
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

    // Initialize trait prices cache with 10-minute TTL
    this.traitPricesCache = new NodeCache({
      stdTTL: 600, // 10 minutes in seconds
      checkperiod: 120, // Check for expired keys every 2 minutes
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

      // Step 2: Pre-fetch DEX-specific data in parallel for LP token resolution
      const hasVyFi = dhPools.some(p => p.dex_name.toLowerCase().includes('vyfi'));
      const hasMinswap = dhPools.some(p => p.dex_name.toLowerCase().includes('minswap'));

      const [vyfiPools, minswapPools] = await Promise.all([
        hasVyFi ? this.fetchVyFiPoolsForToken(tokenUnit) : Promise.resolve([] as VyFiPoolRaw[]),
        hasMinswap ? this.fetchMinswapPoolsForToken(tokenUnit) : Promise.resolve([] as MinswapPoolMetrics[]),
      ]);

      // Step 3: Map to TapToolsTokenPoolDto
      const result: TapToolsTokenPoolDto[] = dhPools.map(pool => {
        const dex = pool.dex_name.toLowerCase();
        let lpTokenUnit = '';

        if (dex.includes('vyfi') && vyfiPools.length > 0) {
          lpTokenUnit = this.extractVyFiLpTokenUnit(vyfiPools[0]);
        } else if (dex.includes('minswap') && minswapPools.length > 0) {
          const match = this.findMinswapPool(minswapPools, tokenUnit);
          lpTokenUnit = match?.id ?? '';
        }

        return {
          exchange: pool.dex_name,
          lpTokenUnit,
          onchainID: pool.pool_id,
          tokenA: tokenUnit,
          tokenALocked: pool.token_2_amount, // base token units
          tokenATicker: '',
          tokenB: '', // ADA
          tokenBLocked: pool.token_1_amount / 1_000_000, // lovelace → ADA
          tokenBTicker: 'ADA',
        };
      });

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

  /**
   * Get LP pool by onchain ID.
   * Tries VyFi /pool/{id} endpoint — works when onchainID is a VyFi pool hash.
   *
   * @param onchainID - Pool onchain identifier (56-char hex script hash)
   */
  async getPoolByOnchainId(onchainID: string): Promise<TapToolsTokenPoolDto | null> {
    if (!this.isMainnet) return null;
    const cacheKey = `onchainID_${onchainID}`;
    const cached = this.poolCache.get<TapToolsTokenPoolDto | null>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const resp = await fetch(`https://api-v3.vyfi.io/pool/${onchainID}`);
      if (resp.ok) {
        const pool: VyFiPoolRaw = await resp.json();
        if (pool) {
          const lpTokenUnit = this.extractVyFiLpTokenUnit(pool);
          let tokenAUnit = '';
          let tokenBUnit = '';
          try {
            const config = JSON.parse(pool.json ?? '{}') as {
              aAsset: VyFiPoolConfigAsset;
              bAsset: VyFiPoolConfigAsset;
            };
            tokenAUnit = `${config.aAsset.currencySymbol}${config.aAsset.tokenName}`;
            tokenBUnit = config.bAsset.currencySymbol; // empty string = ADA
          } catch {
            // ignore json parse errors
          }

          const result: TapToolsTokenPoolDto = {
            exchange: 'VyFi',
            lpTokenUnit,
            onchainID,
            tokenA: tokenAUnit,
            tokenALocked: pool.tokenAQuantity ?? 0,
            tokenATicker: '',
            tokenB: tokenBUnit,
            tokenBLocked: (pool.tokenBQuantity ?? 0) / 1_000_000,
            tokenBTicker: 'ADA',
          };

          this.poolCache.set(cacheKey, result);
          return result;
        }
      }
    } catch {
      this.logger.debug(`VyFi pool lookup failed for onchainID ${onchainID.slice(0, 10)}...`);
    }

    this.poolCache.set(cacheKey, null);
    return null;
  }

  // ─── Pool resolution helpers ─────────────────────────────────────────────────

  /** Fetch VyFi pools for a tokenA/ADA pair */
  private async fetchVyFiPoolsForToken(tokenUnit: string): Promise<VyFiPoolRaw[]> {
    const url =
      `https://api-v3.vyfi.io/lp?networkId=${this.networkId}` + `&tokenAUnit=${tokenUnit}&tokenBUnit=lovelace&v2=true`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return [];
      const data: unknown = await resp.json();
      return Array.isArray(data) ? (data as VyFiPoolRaw[]) : [];
    } catch {
      return [];
    }
  }

  /** Extract concatenated lpTokenUnit from VyFi pool "policyId-assetId" field */
  private extractVyFiLpTokenUnit(pool: VyFiPoolRaw): string {
    const parts = (pool['lpPolicyId-assetId'] ?? '').split('-');
    return parts.length === 2 ? `${parts[0]}${parts[1]}` : '';
  }

  /** Fetch Minswap pools containing a token via POST /v1/pools/metrics */
  private async fetchMinswapPoolsForToken(tokenUnit: string): Promise<MinswapPoolMetrics[]> {
    try {
      const resp = await fetch('https://api-mainnet-prod.minswap.org/v1/pools/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: tokenUnit, limit: 20, only_verified: false }),
      });
      if (!resp.ok) return [];
      const body = await resp.json();
      // API wraps list in { data: [...] }
      return Array.isArray(body?.data) ? (body.data as MinswapPoolMetrics[]) : [];
    } catch {
      return [];
    }
  }

  /** Find the Minswap pool that contains our token */
  private findMinswapPool(pools: MinswapPoolMetrics[], tokenUnit: string): MinswapPoolMetrics | undefined {
    const policyId = tokenUnit.slice(0, 56);
    return pools.find(p => {
      const unitA = `${p.assetA?.policyId ?? ''}${p.assetA?.assetName ?? ''}`;
      const unitB = `${p.assetB?.policyId ?? ''}${p.assetB?.assetName ?? ''}`;
      return unitA === tokenUnit || unitB === tokenUnit || unitA === policyId || unitB === policyId;
    });
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
   * Falls back to TapTools when Charli3 has no data.
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

    return null;
  }

  /**
   * Get trait-based prices for NFT collection from TapTools
   * Used for collections with trait-based pricing (e.g., Relics of Magma)
   *
   * @param policyId - NFT collection policy ID
   * @returns Object containing trait prices by trait type and value, or null if unavailable
   */
  async getTraitPrices(policyId: string): Promise<Record<string, Record<string, number>> | null> {
    if (!this.isMainnet) return null;

    const cacheKey = `trait_prices_${policyId}`;
    const cached = this.traitPricesCache.get<Record<string, Record<string, number>>>(cacheKey);
    if (cached !== undefined) return cached;

    // PRIMARY: Anvil — derives floor prices from marketplace listings
    try {
      const anvilTraits = await this.anvilClient.deriveTraitFloorPrices(policyId, 'Character');
      if (anvilTraits && Object.keys(anvilTraits).length > 0) {
        const result: Record<string, Record<string, number>> = { Character: anvilTraits };
        this.traitPricesCache.set(cacheKey, result);
        return result;
      }
    } catch {
      this.logger.debug(`Anvil trait prices failed for ${policyId}`);
    }

    return null;
  }

  /**
   * Clear all caches (useful for testing or manual refresh)
   */
  clearCache(): void {
    const priceSize = this.priceCache.keys().length;
    const poolSize = this.poolCache.keys().length;
    const ohlcvSize = this.ohlcvCache.keys().length;
    const traitPricesSize = this.traitPricesCache.keys().length;
    const marketDataSize = this.marketDataCache.keys().length;
    const supplySize = this.supplyCache.keys().length;
    this.priceCache.flushAll();
    this.poolCache.flushAll();
    this.ohlcvCache.flushAll();
    this.traitPricesCache.flushAll();
    this.marketDataCache.flushAll();
    this.supplyCache.flushAll();
    this.logger.log(
      `Cleared caches - price: ${priceSize}, pool: ${poolSize}, ohlcv: ${ohlcvSize}, ` +
        `traitPrices: ${traitPricesSize}, marketData: ${marketDataSize}, supply: ${supplySize} entries`
    );
  }

  /**
   * Get cache statistics (useful for monitoring)
   */
  getCacheStats(): {
    price: { size: number; hits: number; misses: number; keys: number };
    pool: { size: number; hits: number; misses: number; keys: number };
    ohlcv: { size: number; hits: number; misses: number; keys: number };
    traitPrices: { size: number; hits: number; misses: number; keys: number };
    marketData: { size: number; hits: number; misses: number; keys: number };
  } {
    const priceStats = this.priceCache.getStats();
    const poolStats = this.poolCache.getStats();
    const ohlcvStats = this.ohlcvCache.getStats();
    const traitPricesStats = this.traitPricesCache.getStats();
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
      traitPrices: {
        size: this.traitPricesCache.keys().length,
        hits: traitPricesStats.hits,
        misses: traitPricesStats.misses,
        keys: traitPricesStats.keys,
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
