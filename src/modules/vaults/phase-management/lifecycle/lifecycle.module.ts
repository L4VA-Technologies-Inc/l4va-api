import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Vault } from '../../../../database/vault.entity';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';
import { VaultsModule } from '../../vaults.module';
import { ContributionModule } from '../contribution/contribution.module';

import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [
    ContributionModule,
    TypeOrmModule.forFeature([Vault]),
    ScheduleModule.forRoot(),
    forwardRef(() => VaultsModule),
    forwardRef(() => BlockchainModule),
  ],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
