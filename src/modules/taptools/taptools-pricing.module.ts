import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TapToolsClient } from './taptools.client';

import { AnvilMarketplaceModule } from '@/modules/anvil/anvil-marketplace.module';
import { Charli3PricingModule } from '@/modules/charli3/charli3-pricing.module';

/**
 * TapTools Pricing Module — routes to Charli3 (price) + Blockfrost SDK (supply) + Anvil (NFT traits).
 * All direct TapTools HTTP calls removed. TapToolsClient is kept as a stable interface.
 */
@Module({
  imports: [ConfigModule, Charli3PricingModule, AnvilMarketplaceModule],
  providers: [TapToolsClient],
  exports: [TapToolsClient],
})
export class TapToolsPricingModule {}
