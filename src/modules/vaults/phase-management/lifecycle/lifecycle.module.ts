import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionModule } from '../../../distribution/distribution.module';
import { TransactionsModule } from '../../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';
import { ContributionModule } from '../contribution/contribution.module';

import { LifecycleService } from './lifecycle.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { LifecycleProcessor } from '@/modules/vaults/phase-management/lifecycle/lifecycle.processor';

@Module({
  imports: [
    ContributionModule,
    DistributionModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault, Asset]),
    ScheduleModule.forRoot(),
    BlockchainModule,
    BullModule.registerQueue({
      name: 'phaseTransition',
    }),
  ],
  providers: [LifecycleService, LifecycleProcessor],
  exports: [LifecycleService],
})
export class LifecycleModule {}
