import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StakeReconciliationService } from './stake-reconciliation.service';
import { StakeController } from './stake.controller';
import { StakeService } from './stake.service';

import { TokenStakingPosition } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Transaction, TokenStakingPosition])],
  controllers: [StakeController],
  providers: [StakeService, StakeReconciliationService],
})
export class StakeModule {}
