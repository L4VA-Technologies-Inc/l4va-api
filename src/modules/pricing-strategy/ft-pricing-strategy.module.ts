import { Module } from '@nestjs/common';

import { Charli3PricingModule } from '@/modules/charli3/charli3-pricing.module';
import { DexHunterPricingModule } from '@/modules/dexhunter/dexhunter-pricing.module';
import { NexusModule } from '@/modules/nexus/nexus.module';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';

import { FTPricingStrategyController } from './ft-pricing-strategy.controller';
import { FTPricingStrategyService } from './ft-pricing-strategy.service';

/**
 * FT Pricing Strategy Module
 *
 * Provides flexible fungible token pricing with:
 * - Configurable default pricing source (VyFi, DexHunter, Charli3, Nexus, Auto)
 * - Policy-specific pricing rules
 * - Admin API for runtime configuration
 */
@Module({
  imports: [DexHunterPricingModule, Charli3PricingModule, TaptoolsModule, NexusModule],
  providers: [FTPricingStrategyService],
  controllers: [FTPricingStrategyController],
  exports: [FTPricingStrategyService],
})
export class FTPricingStrategyModule {}
