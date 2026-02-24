import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { VaultStatus } from '@/types/vault.types';

/**
 * Service responsible for fetching and updating vault token market statistics from Taptools API
 * Runs every 2 hours to get fresh market data from external APIs (Taptools, DexHunter)
 * Updates: FDV, vt_price, market cap, price changes, and checks LP existence
 * Processes both locked and expansion vaults for comprehensive market data coverage
 *
 * IMPORTANT - LP Vault Gains Calculation:
 * For locked vaults with active LP, user gains are calculated using full historical price data:
 *
 * CALCULATION METHOD (Historical OHLCV Data):
 * - Use getTokenFullHistory() to fetch complete OHLCV data from LP inception
 * - Initial VT Price = history[0].open (first day LP was created)
 * - Current VT Price = history[last].close (latest closing price)
 * - Delta = Current Price - Initial Price
 * - User Gains (%) = (Delta / Initial Price) * 100
 * - User Gains (ADA) = Delta * User's VT Token Holdings
 *
 * This reflects market perception and token trading value, which can differ from TVL changes.
 */
@Injectable()
export class VaultMarketStatsService {
  private readonly logger = new Logger(VaultMarketStatsService.name);
  private readonly isMainnet: boolean;
  private readonly axiosTapToolsInstance: AxiosInstance;
  private readonly ohlcvCache: NodeCache;
  private readonly validOHLCVIntervals: readonly string[] = ['1h', '24h', '7d', '30d'];

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    private readonly configService: ConfigService,
    private readonly taptoolsService: TaptoolsService,
    private readonly dexHunterPricingService: DexHunterPricingService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    const tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    const tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');

    this.axiosTapToolsInstance = axios.create({
      baseURL: tapToolsApiUrl,
      headers: {
        'x-api-key': tapToolsApiKey,
      },
    });

    this.ohlcvCache = new NodeCache({
      stdTTL: 300,
      checkperiod: 60,
      useClones: false,
    });
  }

  /**
   * Scheduled task to update market stats for all locked and expansion vaults
   * Runs every 2 hours
   */
  @Cron(CronExpression.EVERY_2_HOURS)
  async scheduledUpdateVaultTokensMarketStats(): Promise<void> {
    try {
      await this.updateVaultTokensMarketStats();
    } catch (error) {
      this.logger.error(
        'Scheduled task: Failed to update vault tokens market stats',
        error instanceof Error ? error.stack : undefined
      );
    }
  }

  /**
   * Update market statistics for all vault tokens
   * Fetches data from Taptools API with DexHunter fallback for newly created tokens
   * Processes both locked and expansion vaults (including those without LP configuration)
   */
  async updateVaultTokensMarketStats(): Promise<void> {
    if (!this.isMainnet) {
      this.logger.log('Not mainnet environment - skipping vault tokens market stats update');
      return;
    }

    // Get ALL locked and expansion vaults (including those without LP configuration)
    // This supports community-created LPs that weren't configured initially
    const vaults = await this.vaultRepository
      .createQueryBuilder('v')
      .select([
        'v.id',
        'v.script_hash',
        'v.asset_vault_name',
        'v.total_assets_cost_ada',
        'v.name',
        'v.ft_token_supply',
        'v.ft_token_decimals',
        'v.liquidity_pool_contribution',
        'v.has_active_lp',
        'v.lp_last_checked',
      ])
      .where('v.vault_status IN (:...statuses)', { statuses: [VaultStatus.locked, VaultStatus.expansion] })
      .andWhere('v.script_hash IS NOT NULL')
      .andWhere('v.asset_vault_name IS NOT NULL')
      .getMany();

    if (!vaults || vaults.length === 0) {
      this.logger.warn('No vault tokens found for market stats update');
      return;
    }

    this.logger.log(`Found ${vaults.length} vaults to update market stats`);

    const tokensMarketData = await Promise.all(
      vaults.map(async vault => {
        const unit = `${vault.script_hash}${vault.asset_vault_name}`;

        try {
          // OPTIMIZATION: Use cheaper DexHunter API first to check if LP exists
          // Only call expensive Taptools API if DexHunter confirms liquidity
          // Exception: If vault already has confirmed LP, skip DexHunter check and go straight to Taptools

          let shouldCallTaptools = vault.has_active_lp === true;

          if (!shouldCallTaptools) {
            // Check liquidity using DexHunter (cheaper API)
            const liquidityCheck = await this.dexHunterPricingService.checkTokenLiquidity(unit);

            if (liquidityCheck?.hasLiquidity) {
              this.logger.log(
                `${vault.name}: DexHunter detected liquidity (${liquidityCheck.totalAdaLiquidity.toFixed(2)} ADA across ${liquidityCheck.pools.length} pool(s))`
              );
              shouldCallTaptools = true;
            } else {
              this.logger.debug(`${vault.name}: No liquidity detected by DexHunter, skipping Taptools API`);

              // Update LP status to false and record check time
              await this.vaultRepository.update(
                { id: vault.id },
                { has_active_lp: false, lp_last_checked: new Date() }
              );

              // Update market stats with no data
              await this.upsertMarketData({
                vault_id: vault.id,
                circSupply: 0,
                mcap: 0,
                totalSupply: 0,
                price_change_1h: 0,
                price_change_24h: 0,
                price_change_7d: 0,
                price_change_30d: 0,
                tvl: vault.total_assets_cost_ada || 0,
                has_market_data: false,
              });

              return null; // Skip Taptools API call
            }
          }

          // Call Taptools API (only if LP exists based on DexHunter or previous confirmation)
          const [{ data: mcapData }, { data: priceChangeData }] = await Promise.all([
            this.axiosTapToolsInstance.get('/token/mcap', { params: { unit } }),
            this.axiosTapToolsInstance.get('/token/prices/chg', {
              params: {
                unit,
                timeframes: '1h,24h,7d,30d',
              },
            }),
          ]);

          const vaultUpdateData: Partial<Vault> = {};
          let hasMarketData = false;

          // Check if Taptools has market data for this token
          if (mcapData?.price && mcapData?.fdv) {
            // Token is traded on DEX with LP
            vaultUpdateData.fdv = mcapData.fdv;
            vaultUpdateData.vt_price = mcapData.price;
            hasMarketData = true;

            this.logger.log(
              `${vault.name}: Taptools market data - Price: ${mcapData.price} ADA, FDV: ${mcapData.fdv} ADA`
            );
          }

          // Update vault if we got any market data
          if (Object.keys(vaultUpdateData).length > 0) {
            await this.vaultRepository.update({ id: vault.id }, vaultUpdateData);
          }

          // Update vault's LP status flag
          const lpStatusUpdate: Partial<{ has_active_lp: boolean; lp_last_checked: Date }> = {
            has_active_lp: hasMarketData,
            lp_last_checked: new Date(),
          };
          await this.vaultRepository.update({ id: vault.id }, lpStatusUpdate);

          // Always update market stats table (even with null values to track attempts)
          const marketData = {
            vault_id: vault.id,
            circSupply: mcapData?.circSupply || 0,
            mcap: mcapData?.mcap || 0,
            totalSupply: mcapData?.totalSupply || 0,
            price_change_1h: priceChangeData?.['1h'] || 0,
            price_change_24h: priceChangeData?.['24h'] || 0,
            price_change_7d: priceChangeData?.['7d'] || 0,
            price_change_30d: priceChangeData?.['30d'] || 0,
            tvl: vault.total_assets_cost_ada || 0, // Pass TVL for delta calculation (Mkt Cap / TVL %)
            has_market_data: hasMarketData, // Track if LP actually exists on DEX
          };

          await this.upsertMarketData(marketData);

          return { vault_id: vault.id, ...marketData, ...vaultUpdateData };
        } catch (error) {
          this.logger.error(
            `Error fetching market data for vault ${vault.name} (${unit}):`,
            error.response?.data || error.message
          );
          return null;
        }
      })
    );

    const successfulUpdates = tokensMarketData.filter(data => data !== null).length;
    const withMarketData = tokensMarketData.filter(data => data?.has_market_data).length;

    this.logger.log(
      `Market stats update complete: ${successfulUpdates}/${vaults.length} processed, ` +
        `${withMarketData} with active market data (LP exists on DEX)`
    );

    // Update user gains for vaults that got price updates
    const vaultIdsWithPriceUpdates = tokensMarketData
      .filter(data => data !== null && data.vt_price)
      .map(data => data.vault_id);

    if (vaultIdsWithPriceUpdates.length > 0) {
      this.logger.log(`Triggering user gains recalculation for ${vaultIdsWithPriceUpdates.length} vaults`);
      try {
        await this.taptoolsService.updateMultipleVaultTotals(vaultIdsWithPriceUpdates);
        this.logger.log(`Successfully updated user gains for vaults with price changes`);
      } catch (error) {
        this.logger.error(
          `Error updating user gains after price updates:`,
          error instanceof Error ? error.stack : undefined
        );
      }
    }
  }

  /**
   * Private helper to fetch OHLCV data from TapTools API
   * Handles the actual API call with caching
   *
   * @param policyId - Token policy ID
   * @param assetName - Token asset name (hex)
   * @param interval - Time interval (1h, 24h, 7d, 30d, 1d)
   * @param numIntervals - Optional number of intervals to return (omit for full history)
   * @param cacheKey - Cache key for storing/retrieving cached data
   * @returns OHLCV data array or null if unavailable
   */
  private async _fetchOHLCV(
    policyId: string,
    assetName: string,
    interval: string,
    numIntervals: number | undefined,
    cacheKey: string
  ): Promise<MarketOhlcvSeries | null> {
    // Check cache first
    const cachedData = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    try {
      const unit = `${policyId}${assetName}`;
      const params: { unit: string; interval: string; numIntervals?: number } = { unit, interval };

      // Only include numIntervals if specified (omitting it returns full history)
      if (numIntervals !== undefined) {
        params.numIntervals = numIntervals;
      }

      const { data } = await this.axiosTapToolsInstance.get<MarketOhlcvSeries>('/token/ohlcv', { params });

      if (!data || data.length === 0) {
        this.logger.debug(`No OHLCV data available for ${policyId}.${assetName} (${interval})`);
        return null;
      }

      // Cache for 5 minutes (same as cache TTL config)
      this.ohlcvCache.set(cacheKey, data);

      return data;
    } catch (error) {
      this.logger.error(
        `Error fetching OHLCV data from TapTools for ${policyId}.${assetName} (interval: ${interval}):`,
        error.response?.data || error.message
      );
      return null;
    }
  }

  async getTokenOHLCV(policyId: string, assetName: string, interval: string = '1h'): Promise<MarketOhlcvSeries | null> {
    if (!this.isMainnet) {
      this.logger.warn('Not mainnet environment - OHLCV data not available');
      return null;
    }

    if (!policyId || !assetName) {
      this.logger.warn('Policy ID and asset name are required for OHLCV data');
      return null;
    }

    if (!this.validOHLCVIntervals.includes(interval)) {
      this.logger.warn(`Invalid interval '${interval}'. Valid are: ${this.validOHLCVIntervals.join(', ')}`);
      return null;
    }

    const cacheKey = `ohlcv_${policyId}_${assetName}_${interval}`;
    return this._fetchOHLCV(policyId, assetName, interval, undefined, cacheKey);
  }

  /**
   * Get FULL historical OHLCV data for a token from LP inception to present
   * Uses 1d interval without numIntervals limit to get complete history
   *
   * This is used to calculate accurate price delta from the very first LP price
   * to the current price, which represents true gains since LP creation.
   *
   * @param policyId - Token policy ID
   * @param assetName - Token asset name (hex)
   * @returns Full OHLCV history array or null if unavailable
   */
  async getTokenFullHistory(policyId: string, assetName: string): Promise<MarketOhlcvSeries | null> {
    if (!this.isMainnet) {
      this.logger.debug('Not mainnet environment - full OHLCV history not available');
      return null;
    }

    if (!policyId || !assetName) {
      this.logger.warn('Policy ID and asset name are required for full OHLCV history');
      return null;
    }

    const cacheKey = `ohlcv_full_${policyId}_${assetName}`;
    const data = await this._fetchOHLCV(policyId, assetName, '1d', undefined, cacheKey);

    if (data && data.length > 0) {
      this.logger.log(
        `Fetched full OHLCV history for ${policyId}.${assetName}: ` +
          `${data.length} days of data (${new Date(data[0].time * 1000).toISOString().split('T')[0]} to ${new Date(data[data.length - 1].time * 1000).toISOString().split('T')[0]})`
      );
    }

    return data;
  }

  /**
   * Calculate price delta from LP inception to current price
   *
   * Uses full OHLCV history to determine:
   * - Initial Price: First day's opening price (when LP was created)
   * - Current Price: Latest day's closing price (right now)
   * - Delta: Current - Initial (absolute price change)
   * - Delta %: (Current - Initial) / Initial * 100 (percentage change)
   *
   * Example:
   * - Full history shows first day open = 0.0007990910179852215 ADA
   * - Latest day close = 0.08556960047153203 ADA
   * - Delta = 0.08556960047153203 - 0.0007990910179852215 = 0.0847705 ADA
   * - Delta % = (0.0847705 / 0.0007990910179852215) * 100 = 10,608% gain
   *
   * @param policyId - Token policy ID
   * @param assetName - Token asset name (hex)
   * @returns Price delta information or null if data unavailable
   */
  async calculateTokenPriceDelta(
    policyId: string,
    assetName: string
  ): Promise<{
    initialPrice: number;
    currentPrice: number;
    delta: number;
    deltaPercent: number;
    daysOfHistory: number;
  } | null> {
    const history = await this.getTokenFullHistory(policyId, assetName);

    if (!history || history.length === 0) {
      return null;
    }

    // Initial price = first day's opening price (LP inception)
    const initialPrice = history[0].open;

    // Current price = latest day's closing price (now)
    const currentPrice = history[history.length - 1].close;

    // Calculate delta
    const delta = currentPrice - initialPrice;
    const deltaPercent = (delta / initialPrice) * 100;

    return {
      initialPrice,
      currentPrice,
      delta,
      deltaPercent,
      daysOfHistory: history.length,
    };
  }

  /**
   * Upserts (inserts or updates) market data for a vault in the Market table
   * Calculates the delta (market cap / TVL percentage) if both mcap and tvl are provided
   * Updates existing market record if found, otherwise creates a new one
   * @param data Market data object containing:
   *   - vault_id: The ID of the vault
   *   - circSupply: Circulating supply of the token
   *   - mcap: Market capitalization
   *   - totalSupply: Total supply of the token
   *   - price_change_1h: Price change percentage over 1 hour
   *   - price_change_24h: Price change percentage over 24 hours
   *   - price_change_7d: Price change percentage over 7 days
   *   - price_change_30d: Price change percentage over 30 days
   *   - tvl: Optional total value locked (used for delta calculation)
   *   - has_market_data: Optional flag indicating if LP exists on DEX
   * @returns The saved Market entity (either updated or newly created)
   */
  async upsertMarketData(data: {
    vault_id: string;
    circSupply: number;
    mcap: number;
    totalSupply: number;
    price_change_1h: number;
    price_change_24h: number;
    price_change_7d: number;
    price_change_30d: number;
    tvl?: number;
    has_market_data?: boolean;
  }): Promise<Market> {
    const calculateDelta = (mcap: number, tvl: number | undefined): number | null => {
      if (!mcap || !tvl || tvl === 0) return null;
      return (mcap / tvl) * 100;
    };

    const delta = calculateDelta(data.mcap, data.tvl);
    const marketData = { ...data, delta };
    delete marketData.tvl;

    const existingMarket = await this.marketRepository.findOne({
      where: { vault_id: data.vault_id },
    });

    if (existingMarket) {
      Object.assign(existingMarket, marketData);
      return await this.marketRepository.save(existingMarket);
    }

    const newMarket = this.marketRepository.create(marketData);
    return await this.marketRepository.save(newMarket);
  }
}
