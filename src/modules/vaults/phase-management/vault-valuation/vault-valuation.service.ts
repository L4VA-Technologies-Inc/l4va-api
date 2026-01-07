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
   * Only updates vaults in contribution, acquire, or governance phases
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
        select: ['id', 'name', 'vault_status'],
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

      this.logger.log(`Successfully updated ${activeVaults.length} vaults with fresh prices`);
    } catch (error) {
      this.logger.error('Error updating vault valuations:', error);
    } finally {
      this.isProcessing = false;
    }
  }
}
