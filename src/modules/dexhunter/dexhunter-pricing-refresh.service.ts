import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { DexHunterPricingService } from './dexhunter-pricing.service';

/**
 * Background service for refreshing VyFi token prices in Redis cache
 * Runs every 10 minutes via cron to keep price data fresh
 */
@Injectable()
export class DexHunterPricingRefreshService {
  private readonly logger = new Logger(DexHunterPricingRefreshService.name);
  private readonly isMainnet: boolean;

  constructor(
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Refresh VyFi price cache every 10 minutes
   */
  @Cron('*/10 * * * *', {
    name: 'vyfi-price-refresh',
    timeZone: 'UTC',
  })
  async refreshPrices(): Promise<void> {
    if (!this.isMainnet) {
      this.logger.debug('Skipping VyFi price refresh for non-mainnet environment');
      return;
    }
    try {
      const count = await this.dexHunterPricingService.refreshVyFiCache();

      if (count !== null) {
        this.logger.log(`VyFi fetchmaster refresh complete: ${count} tokens cached`);
      } else {
        this.logger.warn('VyFi bulk price refresh failed or returned no data');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`VyFi bulk price refresh error: ${errorMessage}`);
      // Don't throw - stale cache is better than crashing the service
    }
  }

  /**
   * Trigger immediate refresh (useful for testing or manual refresh)
   */
  async triggerRefresh(): Promise<number | null> {
    this.logger.log('Manual VyFi price refresh triggered');
    return await this.dexHunterPricingService.refreshVyFiCache();
  }
}
