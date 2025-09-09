import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContributionModule } from '../contribution/contribution.module';

import { LifecycleService } from './lifecycle.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionModule } from '@/modules/distribution/distribution.module';
import { LifecycleProcessor } from '@/modules/vaults/phase-management/lifecycle/lifecycle.processor';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [
    ContributionModule,
    DistributionModule,
    TransactionsModule,
    TypeOrmModule.forFeature([Vault, Asset, Claim, Transaction, TokenRegistry]),
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
