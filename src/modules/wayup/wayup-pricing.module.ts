import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WayUpPricingService } from './wayup-pricing.service';

import { Asset } from '@/database/asset.entity';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';

/**
 * WayUp Pricing Module - Provides only pricing/query functionality
 * No dependencies on BlockchainModule or transaction building
 * This module is safe to import in TaptoolsModule without creating circular dependencies
 */
@Module({
  imports: [TypeOrmModule.forFeature([Asset]), AssetsModule],
  providers: [WayUpPricingService],
  exports: [WayUpPricingService],
})
export class WayUpPricingModule {}
