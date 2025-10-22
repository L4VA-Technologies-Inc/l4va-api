import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';

import { AutomatedDistributionService } from './automated-distribution.service';
import { DistributionService } from './distribution.service';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Vault, Claim, User, Transaction]),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BlockchainModule,
  ],
  providers: [DistributionService, AutomatedDistributionService],
  exports: [DistributionService, AutomatedDistributionService],
})
export class DistributionModule {}
