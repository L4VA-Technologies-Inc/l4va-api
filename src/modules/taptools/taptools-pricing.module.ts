import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TapToolsClient } from './taptools.client';

import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { NexusModule } from '@/modules/nexus/nexus.module';

/**
 * TapTools Pricing Module — routes to DexHunter (price/OHLCV) + Blockfrost SDK (supply).
 * DexHunterPricingClient is registered here directly (it only needs ConfigService) to avoid
 * a circular dependency with DexHunterPricingModule which already imports this module.
 * All direct TapTools HTTP calls removed. TapToolsClient is kept as a stable interface.
 * AnvilClient removed - NFT trait pricing now handled by fallback prices.
 */
@Module({
  imports: [ConfigModule, NexusModule],
  providers: [DexHunterPricingClient, TapToolsClient],
  exports: [TapToolsClient],
})
export class TapToolsPricingModule {}
