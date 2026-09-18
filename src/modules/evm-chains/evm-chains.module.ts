import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EvmChainsService } from './evm-chains.service';

/** Global so any EVM service can resolve a vault's chain without extra wiring. */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [EvmChainsService],
  exports: [EvmChainsService],
})
export class EvmChainsModule {}
