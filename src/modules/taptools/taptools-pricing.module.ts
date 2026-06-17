import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TapToolsClient } from './taptools.client';

import { AnvilMarketplaceModule } from '@/modules/anvil/anvil-marketplace.module';
import { Charli3PricingModule } from '@/modules/charli3/charli3-pricing.module';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';

/**
 * TapTools Pricing Module — routes to Charli3 (price) + Blockfrost SDK (supply) + Anvil (NFT traits).
 * DexHunterPricingClient is registered here directly (it only needs ConfigService) to avoid
 * a circular dependency with DexHunterPricingModule which already imports this module.
 * All direct TapTools HTTP calls removed. TapToolsClient is kept as a stable interface.
 */
@Module({
  imports: [ConfigModule, Charli3PricingModule, AnvilMarketplaceModule],
  providers: [DexHunterPricingClient, TapToolsClient],
  exports: [TapToolsClient],
})
export class TapToolsPricingModule {}
