import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { VaultStatus } from '@/types/vault.types';

/**
 * Service responsible for periodically updating vault asset valuations
 * This ensures cached total values (total_assets_cost_ada, total_assets_cost_usd) stay current
 */
@Injectable()
export class VaultValuationService {
  private readonly logger = new Logger(VaultValuationService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly taptoolsService: TaptoolsService
  ) {}

  /**
   * Update asset prices, vault totals, and FDV calculations every 30 minutes
   *
   * Process:
   * 1. Updates asset prices from APIs (DexHunter for FTs, WayUp for NFTs)
   * 2. Recalculates vault TVL and gains using updated asset prices
   * 3. Recalculates FDV and token prices using appropriate method:
   *    - Vaults with LP: FDV from market price × supply (if available)
   *    - Vaults without LP but with acquirers: FDV from transition calculation
   *    - Vaults without acquirers (0%): FDV = TVL (contributors own all tokens)
   * 4. Updates FDV/TVL ratios for all locked vaults
   *
   * Only processes vaults in contribution, acquire, or locked phases.
   * Active vaults (contribution/acquire) only update prices and TVL, not FDV.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async updateActiveVaultTotals(): Promise<void> {
    if (this.isProcessing) {
      this.logger.warn('Vault valuation update already in progress, skipping...');
      return;
    }

    try {
      this.isProcessing = true;

      // Get active vaults (those with assets that need price updates)
      const activeVaults: Array<
        Pick<
          Vault,
          | 'id'
          | 'name'
          | 'vault_status'
          | 'tokens_for_acquires'
          | 'liquidity_pool_contribution'
          | 'ft_token_supply'
          | 'ft_token_decimals'
          | 'total_assets_cost_ada'
          | 'vt_price'
          | 'policy_id'
        >
      > = await this.vaultRepository.find({
        where: {
          vault_status: In([VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
          deleted: false,
        },
        select: [
          'id',
          'name',
          'vault_status',
          'tokens_for_acquires',
          'liquidity_pool_contribution',
          'ft_token_supply',
          'ft_token_decimals',
          'total_assets_cost_ada',
          'vt_price',
          'policy_id',
        ],
      });

      if (activeVaults.length === 0) {
        this.logger.log('No active vaults to update');
        return;
      }

      const vaultIds = activeVaults.map(v => v.id);

      // Step 1: Update asset prices from APIs
      await this.taptoolsService.updateAssetPrices(vaultIds);

      // Step 2: Recalculate vault totals (TVL, gains) using updated prices
      await this.taptoolsService.updateMultipleVaultTotals(vaultIds);

      // Step 3: Recalculate FDV and token prices for all locked vaults
      // This ensures FDV is always derived from correct source (market price for LP vaults, TVL for no-acquirer vaults)
      await this.calculateFdvAndPrice(activeVaults);

      this.logger.log(`Successfully updated ${activeVaults.length} vaults with fresh prices`);
    } catch (error) {
      this.logger.error('Error updating vault valuations:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Calculate FDV and token price for all vault configurations
   * This provides a single source of truth for FDV calculations
   *
   * Logic by vault type:
   * 1. Locked vaults WITH LP (LP % > 0):
   *    - Try to get market price from Taptools API (if token is traded)
   *    - If available: FDV = market_price × supply
   *    - If not available: FDV = vt_price × supply (use stored price from transition)
   *
   * 2. Locked vaults WITHOUT LP but WITH acquirers (LP % = 0, Acquirers % > 0):
   *    - FDV remains from initial calculation at transition (based on acquisition amounts)
   *    - vt_price = FDV / supply
   *
   * 3. Vaults WITHOUT acquirers (Acquirers % = 0):
   *    - FDV = TVL (all tokens distributed to contributors based on asset value)
   *    - vt_price = FDV / supply = TVL / supply
   *
   * 4. Active vaults (contribution/acquire phases):
   *    - Skip FDV calculation (not locked yet, values still changing)
   */
  private async calculateFdvAndPrice(
    vaults: Array<{
      id: string;
      name: string;
      vault_status: VaultStatus;
      tokens_for_acquires?: number;
      liquidity_pool_contribution?: number;
      ft_token_supply?: number;
      ft_token_decimals?: number;
      total_assets_cost_ada?: number;
      vt_price?: number;
      policy_id?: string;
    }>
  ): Promise<void> {
    const updates: Array<{ id: string; fdv: number; vt_price?: number; fdv_tvl?: number }> = [];

    for (const vault of vaults) {
      // Only calculate FDV for locked vaults
      if (vault.vault_status !== VaultStatus.locked) {
        continue;
      }

      const tokensForAcquires = Number(vault.tokens_for_acquires || 0);
      const lpPercent = Number(vault.liquidity_pool_contribution || 0);
      const tvl = Number(vault.total_assets_cost_ada || 0);
      const supply = vault.ft_token_supply || 0;
      const decimals = vault.ft_token_decimals || 1;

      // Skip if no valid supply or TVL
      if (supply <= 0 || tvl <= 0) {
        continue;
      }

      const vtSupply = supply * Math.pow(10, decimals);
      let fdv: number;
      let vtPrice: number;

      // Case 1: No acquirers (0%) - FDV = TVL
      if (tokensForAcquires === 0) {
        fdv = tvl;
        vtPrice = fdv / vtSupply;

        this.logger.log(
          `Vault ${vault.name}: No acquirers (0%) - FDV = TVL = ${fdv.toFixed(2)} ADA, ` +
            `VT price = ${vtPrice.toFixed(25)} ADA`
        );

        updates.push({
          id: vault.id,
          fdv,
          vt_price: Number(vtPrice.toFixed(25)),
          fdv_tvl: 1.0, // FDV = TVL for this case
        });
        continue;
      }

      // Case 2: Has LP (use market price if available)
      if (lpPercent > 0) {
        // For vaults with LP configured, check if LP actually exists on DEX
        // Market price should be updated by VaultMarketStatsService every 2 hours
        vtPrice = Number(vault.vt_price || 0);

        if (vtPrice > 0) {
          // We have a market price - LP exists and is traded
          fdv = vtPrice * vtSupply;

          this.logger.log(
            `Vault ${vault.name}: With LP - Using market price ${vtPrice.toFixed(25)} ADA, ` +
              `FDV = ${fdv.toFixed(2)} ADA, TVL = ${tvl.toFixed(2)} ADA, FDV/TVL = ${(fdv / tvl).toFixed(2)}`
          );

          updates.push({
            id: vault.id,
            fdv,
            fdv_tvl: Number((fdv / tvl).toFixed(2)),
          });
        } else {
          // LP configured but no market price yet
          // This can happen if:
          // 1. LP transaction was sent but not yet processed
          // 2. LP has no liquidity yet
          // 3. Token not indexed by pricing APIs yet
          // Use transition price as fallback until market price becomes available
          this.logger.warn(
            `Vault ${vault.name}: LP configured (${lpPercent}%) but no market price available yet. ` +
              `LP may be newly created or not yet indexed by pricing APIs. ` +
              `Check VaultMarketStatsService logs for details.`
          );

          // Don't update FDV - keep the value from transition until market price is available
        }
        continue;
      }

      // Case 3: No LP but has acquirers - Keep original FDV from transition, calculate price
      // The FDV was set during phase transition based on acquisition math
      // We just need to ensure vt_price is consistent with it
      if (tokensForAcquires > 0 && lpPercent === 0) {
        // FDV should already be set from transition, just calculate price from it
        // If vt_price exists, derive FDV from it
        vtPrice = Number(vault.vt_price || 0);
        if (vtPrice > 0) {
          fdv = vtPrice * vtSupply;

          this.logger.log(
            `Vault ${vault.name}: No LP, with acquirers - Using transition price ${vtPrice.toFixed(25)} ADA, ` +
              `FDV = ${fdv.toFixed(2)} ADA`
          );

          updates.push({
            id: vault.id,
            fdv,
            fdv_tvl: Number((fdv / tvl).toFixed(2)),
          });
        }
      }
    }

    // Batch update all vaults
    if (updates.length > 0) {
      const updatePromises = updates.map(update =>
        this.vaultRepository.update(
          { id: update.id },
          {
            fdv: update.fdv,
            ...(update.vt_price !== undefined && { vt_price: update.vt_price }),
            ...(update.fdv_tvl !== undefined && { fdv_tvl: update.fdv_tvl }),
          }
        )
      );

      await Promise.all(updatePromises);
      this.logger.log(`Updated FDV and prices for ${updates.length} vaults`);
    }
  }
}
