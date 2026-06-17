import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import { TapToolsTokenPoolDto } from './interfaces/taptools.interface';

import { AnvilClient } from '@/modules/anvil/anvil.client';
import { Charli3Client } from '@/modules/charli3/charli3.client';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';

/**
 * TapTools API client — now a thin wrapper that routes to Charli3 (primary) and Anvil/DexHunter.
 * All direct TapTools HTTP calls have been removed.
 */
@Injectable()
export class TapToolsClient {
  private readonly logger = new Logger(TapToolsClient.name);
  private readonly isMainnet: boolean;
  private readonly blockfrost: BlockFrostAPI;

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
   * Get LP pools for a specific token unit
   * Caches results for 10 minutes since LP pool data is relatively static
   *
   * @param tokenUnit - Full token unit (policyId + assetName in hex)
   * @returns Array of LP pools containing this token
   */
  async getTokenPools(tokenUnit: string): Promise<TapToolsTokenPoolDto[]> {
    if (!this.isMainnet) return [];
    const cacheKey = `tokenUnit_${tokenUnit}`;
    const cached = this.poolCache.get<TapToolsTokenPoolDto[]>(cacheKey);
    if (cached !== undefined) return cached;
    // TapTools disabled — return empty (DexHunter handles pool detection)
    this.poolCache.set(cacheKey, []);
    return [];
  }

  /**
   * Get LP pool by onchain ID
   * Returns the first pool matching the onchain ID, or null if not found
   *
   * @param onchainID - Pool onchain identifier
   * @returns LP pool data or null
   */
  async getPoolByOnchainId(onchainID: string): Promise<TapToolsTokenPoolDto | null> {
    if (!this.isMainnet) return null;
    const cacheKey = `onchainID_${onchainID}`;
    const cached = this.poolCache.get<TapToolsTokenPoolDto | null>(cacheKey);
    if (cached !== undefined) return cached;
    // TapTools disabled — return null
    this.poolCache.set(cacheKey, null);
    return null;
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
      const totalSupply = parseInt(asset.quantity, 10) / Math.pow(10, decimals);
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
