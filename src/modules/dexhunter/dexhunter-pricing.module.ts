import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { DexHunterPricingService } from './dexhunter-pricing.service';

/**
 * DexHunter Pricing Module - Provides only pricing/query functionality
 * No dependencies on BlockchainModule or transaction building
 * This module is safe to import in TaptoolsModule without creating circular dependencies
 */
@Module({
  imports: [HttpModule],
  providers: [DexHunterPricingService],
  exports: [DexHunterPricingService],
})
export class DexHunterPricingModule {}
