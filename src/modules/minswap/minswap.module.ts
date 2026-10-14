import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MinswapService } from './minswap.service';

import { Claim } from '@/database/claim.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Claim]), ConfigModule],
  providers: [MinswapService],
  exports: [MinswapService],
})
export class MinswapModule {}
