import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Transaction } from '../../../database/transaction.entity';
import { Vault } from '../../../database/vault.entity';
import { TransactionsModule } from '../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../processing-tx/onchain/blockchain.module';

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
