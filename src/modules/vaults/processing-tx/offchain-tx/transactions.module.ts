import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

import { Asset } from '@/database/asset.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction, Asset, Vault])],
  providers: [TransactionsService],
  controllers: [TransactionsController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
