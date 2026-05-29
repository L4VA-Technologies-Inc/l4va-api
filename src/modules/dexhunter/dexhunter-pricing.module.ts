import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { TapToolsPricingModule } from '../taptools/taptools-pricing.module';

import { DexHunterPricingClient } from './dexhunter-pricing.client';
import { DexHunterPricingService } from './dexhunter-pricing.service';

/**
 * DexHunter Pricing Module - Provides token pricing functionality with multi-source support
 *
 * Imports TapToolsPricingModule to access TapToolsPricingClient for primary token pricing.
 * Provides both DexHunterPricingClient (fallback source) and DexHunterPricingService (orchestrator).
 *
 * No circular dependencies:
 * - This module imports TapToolsPricingModule (lightweight, only exports TapToolsPricingClient)
 * - TapToolsModule (the main module with TaptoolsService) imports DexHunterPricingModule
 * - TapToolsPricingModule and TapToolsModule are separate modules to break circular dependency
 *
 * This module is safe to import in other modules without creating circular dependencies.
 */
@Module({
  imports: [HttpModule, TapToolsPricingModule],
  providers: [DexHunterPricingClient, DexHunterPricingService],
  exports: [DexHunterPricingService],
})
export class DexHunterPricingModule {}
