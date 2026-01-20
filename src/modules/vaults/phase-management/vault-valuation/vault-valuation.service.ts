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
   * Update asset prices and vault totals for active vaults every 30 minutes
   * 1. Updates asset prices from APIs (DexHunter/WayUp)
   * 2. Recalculates vault totals, gains, and FDV/TVL using new prices
   * Only updates vaults in contribution, acquire, or locked phases
   *
   * Edge cases handled:
   * - Acquirers % = 0%: Use TVL as FDV, no acquire phase
   * - LP % = 0%: No liquidity pool, calculate token price from FDV/Supply
   * - Both can be 0% simultaneously
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
      const activeVaults = await this.vaultRepository.find({
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
        ],
      });

      if (activeVaults.length === 0) {
        this.logger.log('No active vaults to update');
        return;
      }

      const vaultIds = activeVaults.map(v => v.id);

      // Step 1: Update asset prices from APIs
      await this.taptoolsService.updateAssetPrices(vaultIds);

      // Step 2: Recalculate vault totals using updated prices
      await this.taptoolsService.updateMultipleVaultTotals(vaultIds);

      // Step 3: Handle edge cases for FDV/TVL calculations
      await this.handleEdgeCaseFdvCalculations(activeVaults);

      this.logger.log(`Successfully updated ${activeVaults.length} vaults with fresh prices`);
    } catch (error) {
      this.logger.error('Error updating vault valuations:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle edge case FDV calculations for vaults with special configurations
   * - Acquirers % = 0%: FDV = TVL (no acquire phase, contributors get all tokens)
   * - LP % = 0%: Token price = FDV / Supply (no liquidity pool)
   * - Both edge cases can occur simultaneously
   */
  private async handleEdgeCaseFdvCalculations(
    vaults: Array<{
      id: string;
      name: string;
      vault_status: VaultStatus;
      tokens_for_acquires?: number;
      liquidity_pool_contribution?: number;
      ft_token_supply?: number;
      ft_token_decimals?: number;
      total_assets_cost_ada?: number;
    }>
  ): Promise<void> {
    const edgeCaseUpdates: Array<{ id: string; fdv: number; vt_price?: number; fdv_tvl?: number }> = [];

    for (const vault of vaults) {
      const tokensForAcquires = Number(vault.tokens_for_acquires || 0);
      const tvl = Number(vault.total_assets_cost_ada || 0);

      // Skip if no edge cases or no valid TVL
      if (tokensForAcquires > 0 || tvl <= 0) {
        continue;
      }

      // Edge Case: Acquirers % = 0%
      // FDV = TVL (contributed assets value)
      const fdv = tvl;

      const updateData: { id: string; fdv: number; vt_price?: number; fdv_tvl?: number } = {
        id: vault.id,
        fdv,
      };

      // Calculate token price if we have supply information
      if (vault.ft_token_supply && vault.ft_token_decimals) {
        const vtSupply = vault.ft_token_supply * 10 ** vault.ft_token_decimals;
        if (vtSupply > 0) {
          // Edge Case: LP % = 0%
          // Token price = FDV / Supply (no LP exists)
          const vtPrice = fdv / vtSupply;
          updateData.vt_price = Number(vtPrice.toFixed(25));
        }
      }

      // For locked vaults, calculate FDV/TVL ratio (should be 1.0 for 0% acquirers)
      if (vault.vault_status === VaultStatus.locked) {
        updateData.fdv_tvl = 1.0; // FDV = TVL in this edge case
      }

      edgeCaseUpdates.push(updateData);
    }

    // Batch update all edge case vaults
    if (edgeCaseUpdates.length > 0) {
      const updatePromises = edgeCaseUpdates.map(update =>
        this.vaultRepository.update(
          { id: update.id },
          {
            fdv: update.fdv,
            ...(update.vt_price && { vt_price: update.vt_price }),
            ...(update.fdv_tvl !== undefined && { fdv_tvl: update.fdv_tvl }),
          }
        )
      );

      await Promise.all(updatePromises);
    }
  }
}
