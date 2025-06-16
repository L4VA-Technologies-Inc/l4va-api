import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Asset } from 'src/database/asset.entity';
import { Transaction } from 'src/database/transaction.entity';
import { User } from 'src/database/user.entity';
import { Vault } from 'src/database/vault.entity';

import { TransactionsModule } from '../../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../../processing-tx/onchain/blockchain.module';

import { ContributionController } from './contribution.controller';
import { ContributionService } from './contribution.service';

@Module({
  imports: [BlockchainModule, TypeOrmModule.forFeature([Vault, User, Asset, Transaction]), TransactionsModule],
  controllers: [ContributionController],
  providers: [ContributionService],
  exports: [ContributionService],
})
export class ContributionModule {}
