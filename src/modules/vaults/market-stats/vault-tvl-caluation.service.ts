import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { TaptoolsService } from '@/modules/taptools/taptools.service';
import { VaultStatus } from '@/types/vault.types';

/**
 * Service responsible for periodically updating vault asset prices and TVL calculations
 * This ensures cached total values (total_assets_cost_ada, total_assets_cost_usd) stay current
 *
 * IMPORTANT - User TVL and Gains Calculation:
 * User TVL and gains are ONLY calculated for locked or expansion vaults.
 * During contribution/acquire phases, users don't own VT tokens yet.
 *
 * Gains calculation by vault type:
 * - Locked vaults WITH LP: User gains = VT token price appreciation (handled by VaultMarketStatsService)
 *   Calculation: (current_vt_price - initial_vt_price) / initial_vt_price
 * - Locked vaults WITHOUT LP or expansion vaults: User gains = TVL-based asset value changes
 *   Calculation: (current_assets_value - initial_assets_value) / initial_assets_value
 */
@Injectable()
export class VaultTvlCalculationService {
  private readonly logger = new Logger(VaultTvlCalculationService.name);
  private isProcessing = false;
  private readonly activeVaultStatuses = [
    VaultStatus.contribution,
    VaultStatus.acquire,
    VaultStatus.locked,
    VaultStatus.expansion,
  ];

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly taptoolsService: TaptoolsService
  ) {}

  /**
   * Update asset prices and vault TVL every 30 minutes
   *
   * Process:
   * 1. Updates asset prices from APIs (DexHunter for FTs, WayUp for NFTs)
   * 2. Recalculates vault TVL and FDV/TVL using updated asset prices
   *
   *
   * Only processes vaults in contribution, acquire, locked, or expansion phases.
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
      const activeVaults: Array<Pick<Vault, 'id' | 'name' | 'vault_status'>> = await this.vaultRepository.find({
        where: {
          vault_status: In(this.activeVaultStatuses),
          deleted: false,
        },
        select: ['id', 'name', 'vault_status'],
      });

      if (activeVaults.length === 0) {
        this.logger.log('No active vaults to update');
        return;
      }

      const vaultIds = activeVaults.map(v => v.id);

      // Step 1: Update asset prices from APIs
      await this.taptoolsService.updateAssetPrices(vaultIds);

      // Step 2: Recalculate vault totals (TVL, FDV/TVL) using updated prices
      await this.taptoolsService.updateMultipleVaultTotals(vaultIds);

      this.logger.log(`Successfully updated ${activeVaults.length} vaults with fresh prices and TVL`);
    } catch (error) {
      this.logger.error('Error updating vault valuations:', error);
    } finally {
      this.isProcessing = false;
    }
  }
}
