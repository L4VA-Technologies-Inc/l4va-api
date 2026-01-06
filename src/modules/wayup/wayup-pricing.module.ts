import { Module } from '@nestjs/common';

import { WayUpPricingService } from './wayup-pricing.service';

/**
 * WayUp Pricing Module - Provides only pricing/query functionality
 * No dependencies on BlockchainModule or transaction building
 * This module is safe to import in TaptoolsModule without creating circular dependencies
 */
@Module({
  providers: [WayUpPricingService],
  exports: [WayUpPricingService],
})
export class WayUpPricingModule {}
