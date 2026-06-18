import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { RedisModule } from '../redis/redis.module';
import { TapToolsPricingModule } from '../taptools/taptools-pricing.module';

import { DexHunterPricingRefreshService } from './dexhunter-pricing-refresh.service';
import { DexHunterPricingClient } from './dexhunter-pricing.client';
import { DexHunterPricingService } from './dexhunter-pricing.service';

/**
 * DexHunter Pricing Module - Provides token pricing functionality with multi-source support
 *
 * Imports:
 * - HttpModule: For HTTP requests to external APIs
 * - TapToolsPricingModule: For TapToolsClient (Charli3 pricing fallback)
 * - RedisModule: For VyFi bulk price caching
 * - ScheduleModule: For background cron tasks (VyFi price refresh every 10 minutes)
 *
 * Providers:
 * - DexHunterPricingClient: Redis-backed price caching and DexHunter API client
 * - DexHunterPricingService: Multi-source pricing orchestrator
 * - DexHunterPricingRefreshService: Background cron task for VyFi bulk price refresh (internal only)
 *
 * No circular dependencies:
 * - This module imports TapToolsPricingModule (lightweight, only exports TapToolsClient)
 * - TapToolsModule (the main module with TaptoolsService) imports DexHunterPricingModule
 * - TapToolsPricingModule and TapToolsModule are separate modules to break circular dependency
 *
 * This module is safe to import in other modules without creating circular dependencies.
 */
@Module({
  imports: [HttpModule, TapToolsPricingModule, RedisModule, ScheduleModule],
  providers: [DexHunterPricingClient, DexHunterPricingService, DexHunterPricingRefreshService],
  exports: [DexHunterPricingClient, DexHunterPricingService],
})
export class DexHunterPricingModule {}
