import { Module } from '@nestjs/common';
import { LpTokensService } from './services/lp-tokens.service';

@Module({
  controllers: [],
  providers: [LpTokensService],
  exports: [LpTokensService],
})
export class LpTokensModule {}
