import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Transaction } from '../../database/transaction.entity';
import { Vault } from '../../database/vault.entity';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { TransactionsModule } from '../transactions/transactions.module';

import { LpTokensController } from './lp-tokens.controller';
import { LpTokensService } from './services/lp-tokens.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, Vault]),
    forwardRef(() => TransactionsModule),
    BlockchainModule,
    ConfigModule,
  ],
  controllers: [LpTokensController],
  providers: [LpTokensService],
  exports: [LpTokensService],
})
export class LpTokensModule {}
