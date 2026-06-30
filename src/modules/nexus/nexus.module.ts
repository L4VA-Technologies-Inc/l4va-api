import { Module } from '@nestjs/common';

import { NexusClient } from './nexus.client';

/**
 * Nexus API module
 * Provides DEX pool data resolution via Gero Wallet Nexus API
 */
@Module({
  providers: [NexusClient],
  exports: [NexusClient],
})
export class NexusModule {}
