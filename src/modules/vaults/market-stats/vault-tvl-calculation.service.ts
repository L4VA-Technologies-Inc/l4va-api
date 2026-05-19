import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * - Locked vaults WITH LP: User gains = VT token price appreciation
 *   Calculation: Uses full OHLCV history from TapTools (first day open → latest close)
 *   Formula: (current_price - initial_price) / initial_price * 100
 * - Locked vaults WITHOUT LP or expansion vaults: User gains = TVL-based asset value changes
 *   Calculation: (current_assets_value - initial_assets_value) / initial_assets_value
 */
@Injectable()
export class VaultTvlCalculationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VaultTvlCalculationService.name);
  private isProcessing = false;
  private updateTimeout: NodeJS.Timeout | null = null;

  private readonly baseIntervalMs: number;
  private readonly jitterMs: number;
  private readonly activeVaultStatuses = [
    VaultStatus.contribution,
    VaultStatus.acquire,
    VaultStatus.locked,
    VaultStatus.expansion,
  ];

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly taptoolsService: TaptoolsService,
    private readonly configService: ConfigService
  ) {
    const baseIntervalMinutes = this.configService.get<number>('VAULT_TVL_UPDATE_BASE_MINUTES') ?? 30;
    const jitterMinutes = this.configService.get<number>('VAULT_TVL_UPDATE_JITTER_MINUTES') ?? 5;

    this.baseIntervalMs = Math.max(1, baseIntervalMinutes) * 60 * 1000;
    this.jitterMs = Math.max(0, jitterMinutes) * 60 * 1000;
  }

  onModuleInit(): void {
    this.scheduleNextUpdate();
  }

  onModuleDestroy(): void {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
  }

  private getNextIntervalMs(): number {
    if (this.jitterMs === 0) {
      return this.baseIntervalMs;
    }

    const jitterOffset = Math.floor(Math.random() * (this.jitterMs * 2 + 1)) - this.jitterMs;
    return Math.max(60_000, this.baseIntervalMs + jitterOffset);
  }

  private scheduleNextUpdate(): void {
    const delayMs = this.getNextIntervalMs();
    const delayMinutes = (delayMs / 60_000).toFixed(2);
    this.logger.debug(`Next vault valuation update scheduled in ${delayMinutes} minutes`);

    this.updateTimeout = setTimeout(() => {
      void this.executeScheduledUpdate();
    }, delayMs);
  }

  private async executeScheduledUpdate(): Promise<void> {
    try {
      await this.updateActiveVaultTotals();
    } finally {
      this.scheduleNextUpdate();
    }
  }

  /**
   * Update asset prices and vault TVL on a randomized interval
   *
   * Process:
   * 1. Updates asset prices from APIs (DexHunter for FTs, WayUp for NFTs)
   * 2. Recalculates vault TVL and FDV/TVL using updated asset prices
   *
   *
   * Only processes vaults in contribution, acquire, locked, or expansion phases.
   */
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
