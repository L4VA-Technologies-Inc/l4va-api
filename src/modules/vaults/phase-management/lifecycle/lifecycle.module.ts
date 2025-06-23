import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributionModule } from '../../../distribution/distribution.module';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';
import { VaultsModule } from '../../vaults.module';
import { ContributionModule } from '../contribution/contribution.module';

import { LifecycleService } from './lifecycle.service';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    ContributionModule,
    DistributionModule,
    TypeOrmModule.forFeature([Vault, Asset]),
    ScheduleModule.forRoot(),
    forwardRef(() => VaultsModule),
    forwardRef(() => BlockchainModule),
  ],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
