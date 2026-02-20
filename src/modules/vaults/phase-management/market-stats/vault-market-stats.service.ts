import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { VyfiService } from '@/modules/vyfi/vyfi.service';
import { VaultStatus } from '@/types/vault.types';

/**
 * Service responsible for fetching and updating vault token market statistics
 * Runs every 2 hours to get fresh market data from external APIs (Taptools, DexHunter)
 * Updates: FDV, vt_price, market cap, price changes, and checks LP existence
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
    private readonly vyfiService: VyfiService,
    private readonly taptoolsService: TaptoolsService
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
   * Scheduled task to update market stats for all locked vaults with LPs
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
   * Only processes locked vaults that have LP configuration (LP % > 0)
   */
  async updateVaultTokensMarketStats(): Promise<void> {
    if (!this.isMainnet) {
      this.logger.log('Not mainnet environment - skipping vault tokens market stats update');
      return;
    }

    // Get vaults with LP configuration
    const vaults = await this.vaultRepository
      .createQueryBuilder('v')
      .select([
        'v.id',
        'v.policy_id',
        'v.asset_vault_name',
        'v.total_assets_cost_ada',
        'v.name',
        'v.ft_token_supply',
        'v.ft_token_decimals',
      ])
      .where('v.vault_status = :status', { status: VaultStatus.locked })
      .andWhere('v.liquidity_pool_contribution > 0')
      .andWhere('v.policy_id IS NOT NULL')
      .andWhere('v.asset_vault_name IS NOT NULL')
      .getMany();

    if (!vaults || vaults.length === 0) {
      this.logger.warn('No vault tokens found for market stats update');
      return;
    }

    this.logger.log(`Found ${vaults.length} vaults to update market stats`);

    const tokensMarketData = await Promise.all(
      vaults.map(async vault => {
        const unit = `${vault.policy_id}${vault.asset_vault_name}`;

        try {
          // Try Taptools first
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
          } else {
            // Taptools doesn't have data yet - check if LP exists on VyFi
            this.logger.warn(
              `${vault.name}: No Taptools market data (price: ${mcapData?.price}, fdv: ${mcapData?.fdv}). Checking VyFi...`
            );

            try {
              // Check if VyFi pool exists
              const poolCheck = await this.vyfiService.checkPool({
                networkId: 1, // mainnet
                tokenAUnit: unit,
                tokenBUnit: 'lovelace',
              });

              if (poolCheck.exists && poolCheck.data && poolCheck.data.length > 0) {
                this.logger.log(`${vault.name}: VyFi pool exists. Calculating price from reserves...`);
                hasMarketData = true;

                // Calculate price from VyFi pool reserves
                const poolData = poolCheck.data[0];
                const tokenReserve = Number(poolData.tokenAQuantity || 0);
                const adaReserveLovelace = Number(poolData.tokenBQuantity || 0);
                const adaReserve = adaReserveLovelace / 1_000_000; // Convert lovelace to ADA

                if (tokenReserve > 0 && adaReserve > 0) {
                  // Price per token (in smallest unit) = ADA reserve / Token reserve
                  const pricePerSmallestUnit = adaReserve / tokenReserve;

                  // Adjust for token decimals to get price per whole token
                  const decimals = vault.ft_token_decimals || 1;
                  const vtPrice = pricePerSmallestUnit * Math.pow(10, decimals);

                  vaultUpdateData.vt_price = vtPrice;

                  // Calculate FDV = price × total supply
                  const supply = vault.ft_token_supply || 0;
                  if (supply > 0) {
                    const vtSupply = supply * Math.pow(10, decimals);
                    const fdv = vtPrice * vtSupply;
                    vaultUpdateData.fdv = fdv;

                    this.logger.log(
                      `${vault.name}: Calculated from VyFi - Price: ${vtPrice.toFixed(25)} ADA, FDV: ${fdv.toFixed(2)} ADA ` +
                        `(Reserves: ${tokenReserve} tokens / ${adaReserve.toFixed(2)} ADA)`
                    );
                  } else {
                    this.logger.log(
                      `${vault.name}: Calculated price from VyFi: ${vtPrice.toFixed(25)} ADA (no supply for FDV)`
                    );
                  }
                } else {
                  this.logger.warn(
                    `${vault.name}: VyFi pool exists but has invalid reserves (${tokenReserve} tokens / ${adaReserve} ADA)`
                  );
                }
              } else {
                // No pool on VyFi yet
                this.logger.warn(`${vault.name}: No VyFi pool found. LP creation may be pending or failed.`);
                hasMarketData = false;
              }
            } catch (vyfiError) {
              this.logger.error(
                `${vault.name}: VyFi pool check failed: ${vyfiError.message}. Cannot determine LP status.`
              );
              hasMarketData = false;
            }
          }

          // Update vault if we got any market data
          if (Object.keys(vaultUpdateData).length > 0) {
            await this.vaultRepository.update({ id: vault.id }, vaultUpdateData);
          }

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
          throw new ServiceUnavailableException(
            `Failed to fetch market data for vault ${vault.name}. Please try again later.`
          );
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
   * Check if a vault token actually has liquidity on DEX (VyFi)
   * Returns pool info if LP exists, null otherwise
   * @param policyId Token policy ID
   * @param assetName Token asset name (hex)
   */
  async hasActiveLiquidity(
    policyId: string,
    assetName: string
  ): Promise<{
    exists: boolean;
    poolData?: any;
  }> {
    if (!this.isMainnet) {
      return { exists: false };
    }

    try {
      const unit = `${policyId}${assetName}`;

      // Check VyFi for pool existence
      const poolCheck = await this.vyfiService.checkPool({
        networkId: 1, // mainnet
        tokenAUnit: unit,
        tokenBUnit: 'lovelace',
      });

      if (poolCheck.exists) {
        return { exists: true, poolData: poolCheck.data };
      }

      return { exists: false };
    } catch (error) {
      this.logger.warn(`Could not check liquidity for ${policyId}.${assetName}: ${error.message}`);
      return { exists: false };
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
    const cachedData = this.ohlcvCache.get<MarketOhlcvSeries>(cacheKey);

    if (cachedData) {
      return cachedData;
    }

    try {
      const unit = `${policyId}${assetName}`;
      const { data } = await this.axiosTapToolsInstance.get<MarketOhlcvSeries>('/token/ohlcv', {
        params: { unit, interval },
      });

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
