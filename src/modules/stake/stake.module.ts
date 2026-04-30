import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StakeAdminController } from './stake-admin/stake-admin.controller';
import { StakeAdminService } from './stake-admin/stake-admin.service';
import { StakeReconciliationService } from './stake-reconciliation.service';
import { StakeController } from './stake.controller';
import { StakeService } from './stake.service';

import { TokenStakingPosition } from '@/database/tokenStakingPosition.entity';
import { Transaction } from '@/database/transaction.entity';
import { AlertsModule } from '@/modules/alerts/alerts.module';

@Module({
  imports: [ConfigModule, AlertsModule, TypeOrmModule.forFeature([Transaction, TokenStakingPosition])],
  controllers: [StakeController, StakeAdminController],
  providers: [StakeService, StakeReconciliationService, StakeAdminService],
})
export class StakeModule {}
