import { Module } from '@nestjs/common';

import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

import { MarketModule } from '@/modules/market/market.module';
import { TapToolsPricingModule } from '@/modules/taptools/taptools-pricing.module';

@Module({
  imports: [TapToolsPricingModule, MarketModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
