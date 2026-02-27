import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionHealthService } from './transaction-health.service';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

import { Asset } from '@/database/asset.entity';
import { Proposal } from '@/database/proposal.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { GoogleCloudStorageModule } from '@/modules/google_cloud/google_bucket/bucket.module';
import { TaptoolsModule } from '@/modules/taptools/taptools.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, Asset, Vault, User, Proposal]),
    TaptoolsModule,
    GoogleCloudStorageModule,
  ],
  providers: [TransactionsService, TransactionHealthService],
  controllers: [TransactionsController],
  exports: [TransactionsService, TransactionHealthService],
})
export class TransactionsModule {}
