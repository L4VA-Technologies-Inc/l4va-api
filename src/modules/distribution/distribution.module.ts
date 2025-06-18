import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionController } from './distribution.controller';
import { DistributionService } from './distribution.service';
import { LiquidityPoolService } from './lp.service';

import { Vault } from '@/database/vault.entity';

@Module({
  controllers: [DistributionController],
  providers: [DistributionService, LiquidityPoolService],
  imports: [TypeOrmModule.forFeature([Vault])],
})
export class DistributionModule {}
