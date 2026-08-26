import { Module } from '@nestjs/common';

import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';

import { TapToolsPricingModule } from '@/modules/taptools/taptools-pricing.module';

@Module({
  imports: [TapToolsPricingModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
