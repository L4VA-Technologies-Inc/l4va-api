import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Asset } from '@/database/asset.entity';
import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { MarketOhlcvSeries } from '@/modules/market/dto/market-ohlcv.dto';
import { TapToolsClient } from '@/modules/taptools/taptools.client';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { AssetType } from '@/types/asset.types';
import { VAULT_STATUSES_WITH_POTENTIAL_LP } from '@/types/vault.types';

/**
 * Service responsible for fetching and updating vault token market statistics from external APIs
 * Runs every 2 hours to get fresh market data from DexHunter and Taptools
 *
 * DATA SOURCES & RESPONSIBILITIES:
 * 1. DexHunter (ALWAYS called): Tracks total ADA liquidity across ALL DEX pools
 *    - Provides comprehensive cross-DEX liquidity aggregation
 *    - Returns totalAdaLiquidity (stored in market.totalAdaLiquidity)
 *    - Determines if any LP exists for the vault token
 *
 * 2. Taptools (called if LP exists): Provides OHLCV price data and market metrics
 *    - FDV, vt_price, market cap, price changes (1h, 24h, 7d, 30d)
 *    - Historical OHLCV data for gains calculations
 *
 * Updates locked, expansion, and acquire_expansion vaults (including community-created LPs)
 *
 * IMPORTANT - LP Vault Gains Calculation:
 * For locked, expansion, and acquire_expansion vaults with active LP, user gains are calculated using full historical price data:
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

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly taptoolsService: TaptoolsService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly dexHunterClient: DexHunterPricingClient
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Scheduled task to update market stats for all locked and expansion vaults
   * Runs every 30 minutes
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledUpdateVaultTokensMarketStats(): Promise<void> {
    try {
      await this.updateVaultTokensMarketStats();
    } catch (error: any) {
      this.logger.error(
        'Scheduled task: Failed to update vault tokens market stats',
        error instanceof Error ? error.stack : undefined
      );
    }
  }

  /**
   * Update market statistics for all vault tokens
   *
   * Process:
   * 1. DexHunter API: Always called first to get totalAdaLiquidity across all DEX pools
   * 2. Taptools API: Called if DexHunter confirms liquidity exists (for OHLCV/price data)
   *
   * Processes locked, expansion, and acquire_expansion vaults (including those without LP configuration)
   * Supports community-created LPs that weren't configured during vault creation
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
      .where('v.vault_status IN (:...statuses)', {
        statuses: VAULT_STATUSES_WITH_POTENTIAL_LP,
      })
      .andWhere('v.script_hash IS NOT NULL')
      .andWhere('v.asset_vault_name IS NOT NULL')
      .getMany();

    if (!vaults || vaults.length === 0) {
      this.logger.warn('No vault tokens found for market stats update');
      return;
    }

    const vaultIds = vaults.map(v => v.id);

    const assets = await this.assetRepository.find({
      where: {
        vault_id: In(vaultIds),
        type: In([AssetType.NFT, AssetType.FT]),
      },
    });

    const nftOnlyVaults = new Map<string, number>();
    const vaultsWithFt = new Set<string>();

    for (const asset of assets) {
      if (asset.type === AssetType.FT) {
        vaultsWithFt.add(asset.vault_id);
        nftOnlyVaults.delete(asset.vault_id);
        continue;
      }

      if (asset.type === AssetType.NFT && !vaultsWithFt.has(asset.vault_id)) {
        const currentCount = nftOnlyVaults.get(asset.vault_id) || 0;
        nftOnlyVaults.set(asset.vault_id, currentCount + 1);
      }
    }

    const tokensMarketData = await Promise.all(
      vaults.map(async vault => {
        const unit = `${vault.script_hash}${vault.asset_vault_name}`;

        try {
          // Step 1: ALWAYS call DexHunter to get comprehensive liquidity data
          // DexHunter aggregates liquidity across ALL DEX pools and returns totalAdaLiquidity
          // This data is essential and stored in market.totalAdaLiquidity
          const liquidityCheck = await this.dexHunterPricingService.checkTokenLiquidity(unit);

          if (!liquidityCheck?.hasLiquidity) {
            // this.logger.debug(`${vault.name}: No liquidity detected by DexHunter, skipping Taptools API`);

            // Update LP status to false and record check time, but do NOT upsert market data
            await this.vaultRepository.update({ id: vault.id }, { has_active_lp: false, lp_last_checked: new Date() });

            return null; // Skip Taptools since no LP exists
          }

          // Step 2: Call Taptools API for OHLCV/price data (only if DexHunter confirmed liquidity)
          const [mcapData, priceChangeData] = await Promise.all([
            this.tapToolsClient.getTokenMarketCap(unit),
            this.tapToolsClient.getTokenPriceChanges(unit, '1h,24h,7d,30d'),
          ]);

          const vaultUpdateData: Partial<Vault> = {};
          let hasMarketData = false;

          // Check if TapTools or Charli3 provided a price
          if (mcapData?.price) {
            if (mcapData.fdv > 0) vaultUpdateData.fdv = mcapData.fdv;
            vaultUpdateData.vt_price = mcapData.price;
            hasMarketData = true;
          } else {
            // Final fallback: derive price from DexHunter pool reserves (adaAmount / tokenAmount)
            // This works for any token with DEX liquidity even when no pricing API indexes it
            const totalAda = liquidityCheck.pools.reduce((s, p) => s + p.adaAmount, 0);
            const totalToken = liquidityCheck.pools.reduce((s, p) => s + p.tokenAmount, 0);
            if (totalAda > 0 && totalToken > 0) {
              const derivedPrice = totalAda / totalToken;
              vaultUpdateData.vt_price = derivedPrice;
              hasMarketData = true;
              this.logger.log(
                `${vault.name}: using DexHunter pool-derived price ${derivedPrice.toFixed(8)} ADA ` +
                  `(${totalAda.toFixed(2)} ADA / ${totalToken.toFixed(0)} tokens across ${liquidityCheck.pools.length} pool(s))`
              );
            }
          }

          // Update vault if we got any market data
          if (Object.keys(vaultUpdateData).length > 0) {
            await this.vaultRepository.update({ id: vault.id }, vaultUpdateData);
          }

          // Update vault's LP status — trust DexHunter's liquidity detection, not price data availability
          const lpStatusUpdate: Partial<{ has_active_lp: boolean; lp_last_checked: Date }> = {
            has_active_lp: liquidityCheck.hasLiquidity,
            lp_last_checked: new Date(),
          };
          await this.vaultRepository.update({ id: vault.id }, lpStatusUpdate);

          // FDV/Asset: only for NFT-only vaults (any FT asset → null). Divides by NFT assets count.
          const isNftOnlyVault = nftOnlyVaults.get(vault.id) ?? false;
          const fdv = vaultUpdateData.fdv != null ? Number(vaultUpdateData.fdv) : null;
          const nftAssetsCount = nftOnlyVaults.get(vault.id) ?? 0;
          const fdvPerAsset =
            isNftOnlyVault && fdv != null && fdv > 0 && nftAssetsCount > 0 ? fdv / nftAssetsCount : null;

          // Update market stats table with combined data from DexHunter + Taptools
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
            has_market_data: hasMarketData, // Track if LP exists (based on Taptools data)
            totalAdaLiquidity: liquidityCheck?.totalAdaLiquidity ?? null, // Total ADA across all DEX pools (from DexHunter)
            fdv_per_asset: fdvPerAsset, // FDV / assets count. Only for NFT-only vaults
          };

          await this.upsertMarketData(marketData);

          return { vault_id: vault.id, ...marketData, ...vaultUpdateData };
        } catch (error: any) {
          this.logger.error(
            `Error fetching market data for vault ${vault.name} (${unit}):`,
            error instanceof Error ? error.message : String(error)
          );
          return null;
        }
      })
    );

    const successfulUpdates = tokensMarketData.filter(data => data !== null).length;
    const withActiveLp = tokensMarketData.filter(data => data?.has_market_data).length;

    // Update user gains for vaults that got price updates
    const vaultIdsWithPriceUpdates = tokensMarketData
      .filter(data => data !== null && data.vt_price)
      .map(data => data.vault_id);

    if (vaultIdsWithPriceUpdates.length > 0) {
      try {
        await this.taptoolsService.updateMultipleVaultTotals(vaultIdsWithPriceUpdates);
        this.logger.log(
          `Market update complete: ${successfulUpdates}/${vaults.length} vaults processed, ` +
            `${withActiveLp} with active LP, ${vaultIdsWithPriceUpdates.length} user gains updated`
        );
      } catch (error: any) {
        this.logger.error(
          `Error updating user gains after price updates:`,
          error instanceof Error ? error.stack : undefined
        );
      }
    } else {
      this.logger.log(
        `Market update complete: ${successfulUpdates}/${vaults.length} vaults processed, ` +
          `${withActiveLp} with active LP, no price changes`
      );
    }
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

    // Try TapTools first (primary source)
    let data = await this.tapToolsClient.getTokenOHLCV(policyId, assetName, '1d');

    // Fallback to DexHunter if TapTools fails or returns null
    if (!data) {
      data = await this.dexHunterClient.getTokenOHLCV(policyId, assetName, '1d');

      if (data) {
        this.logger.log(`DexHunter OHLCV fallback successful for ${policyId}.${assetName}`);
      } else {
        this.logger.warn(`Both TapTools and DexHunter OHLCV unavailable for ${policyId}.${assetName}`);
      }
    }

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
   * - Current Price: Latest day's opening price (current open trading price)
   * - Delta: Current - Initial (absolute price change)
   * - Delta %: (Current - Initial) / Initial * 100 (percentage change)
   *
   * Example:
   * - Full history shows first day open = 0.0007990910179852215 ADA
   * - Latest day open = 0.08556960047153203 ADA
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

    // Current price = latest day's opening price (current open trading price)
    const currentPrice = history[history.length - 1].open;

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
   *   - totalAdaLiquidity: Optional total ADA across all DEX pools from DexHunter. Set to null when no LP exists or when DexHunter returns no liquidity. Set to a number (>= 0) when LP exists and liquidity is available.
   *   - fdv_per_asset: Optional FDV / NFT assets count. Null for FT-only vaults (no NFT assets).
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
    totalAdaLiquidity?: number | null;
    fdv_per_asset?: number | null;
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
