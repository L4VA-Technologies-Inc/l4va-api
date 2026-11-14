import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainModule } from '../../processing-tx/blockchain.module';
import { TransactionsModule } from '../../processing-tx/transactions/transactions.module';

import { ContributionController } from './contribution.controller';
import { ContributionService } from './contribution.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    BlockchainModule,
    TypeOrmModule.forFeature([Vault, User, Asset, Transaction, Claim, Proposal]),
    TransactionsModule,
  ],
  controllers: [ContributionController],
  providers: [ContributionService],
  exports: [ContributionService],
})
export class ContributionModule {}
