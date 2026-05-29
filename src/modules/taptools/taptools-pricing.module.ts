import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TapToolsPricingClient } from './taptools-pricing.client';

/**
 * TapTools Pricing Module - Provides only token pricing client
 * Lightweight module that exports TapToolsPricingClient without other dependencies
 *
 * This module is separate from TaptoolsModule to avoid circular dependencies:
 * - TaptoolsModule imports DexHunterPricingModule
 * - DexHunterPricingModule imports TapToolsPricingModule (this module)
 * - No reverse dependency from TapToolsPricingModule back to DexHunterPricingModule
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 3,
    }),
    ConfigModule,
  ],
  providers: [TapToolsPricingClient],
  exports: [TapToolsPricingClient],
})
export class TapToolsPricingModule {}
