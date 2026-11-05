import { Module } from '@nestjs/common';

import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

import { MarketModule } from '@/modules/market/market.module';
import { TapToolsPricingModule } from '@/modules/taptools/taptools-pricing.module';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';

@Module({
  imports: [TapToolsPricingModule, MarketModule],
  controllers: [TokensController],
  providers: [TokensService, EvmContractReader],
  exports: [TokensService],
})
export class TokensModule {}
