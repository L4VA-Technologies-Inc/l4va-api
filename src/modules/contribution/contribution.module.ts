import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Asset } from '../../database/asset.entity';
import { Transaction } from '../../database/transaction.entity';
import { User } from '../../database/user.entity';
import { Vault } from '../../database/vault.entity';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { TaptoolsModule } from '../taptools/taptools.module';
import { TransactionsModule } from '../transactions/transactions.module';

import { ContributionController } from './contribution.controller';
import { ContributionService } from './contribution.service';

@Module({
  imports: [
    TaptoolsModule,
    BlockchainModule,
    TypeOrmModule.forFeature([Vault, User, Asset, Transaction]),
    TransactionsModule,
  ],
  controllers: [ContributionController],
  providers: [ContributionService],
  exports: [ContributionService],
})
export class ContributionModule {}
