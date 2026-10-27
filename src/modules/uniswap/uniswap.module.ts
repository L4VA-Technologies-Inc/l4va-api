import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { UniswapTradingController } from './uniswap-trading.controller';
import { UniswapTradingService } from './uniswap-trading.service';

@Module({
  imports: [HttpModule],
  controllers: [UniswapTradingController],
  providers: [UniswapTradingService],
  exports: [UniswapTradingService],
})
export class UniswapModule {}
