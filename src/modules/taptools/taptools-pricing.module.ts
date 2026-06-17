import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TapToolsClient } from './taptools.client';

import { Charli3PricingModule } from '@/modules/charli3/charli3-pricing.module';

/**
 * TapTools Pricing Module - Provides only token pricing client
 * Lightweight module that exports TapToolsClient without other dependencies
 *
 * This module is separate from TaptoolsModule to avoid circular dependencies:
 * - TaptoolsModule imports DexHunterPricingModule
 * - DexHunterPricingModule imports TapToolsPricingModule (this module)
 * - No reverse dependency from TapToolsPricingModule back to DexHunterPricingModule
 *
 * Includes Charli3PricingModule for fallback when TapTools API is unavailable
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 3,
    }),
    ConfigModule,
    Charli3PricingModule,
  ],
  providers: [TapToolsClient],
  exports: [TapToolsClient],
})
export class TapToolsPricingModule {}
