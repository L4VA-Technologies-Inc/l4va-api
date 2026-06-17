import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AnvilClient } from './anvil.client';

/**
 * Anvil Marketplace Module - Provides NFT market data as TapTools fallback.
 * Exports AnvilClient for collection floor prices and trait-based pricing.
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 15000,
      maxRedirects: 3,
    }),
    ConfigModule,
  ],
  providers: [AnvilClient],
  exports: [AnvilClient],
})
export class AnvilMarketplaceModule {}
