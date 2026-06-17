import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { Charli3Client } from './charli3.client';

/**
 * Charli3 Pricing Module - Provides token pricing client as TapTools fallback
 * Lightweight module that exports Charli3Client without other dependencies
 *
 * This module is separate to avoid circular dependencies and provides
 * a fallback pricing source when TapTools API is unavailable.
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 3,
    }),
    ConfigModule,
  ],
  providers: [Charli3Client],
  exports: [Charli3Client],
})
export class Charli3PricingModule {}
