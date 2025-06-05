import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LpTokensService } from './services/lp-tokens.service';
import { LpTokensController } from './lp-tokens.controller';
import { Transaction } from '../../../database/transaction.entity';
import { Vault } from '../../../database/vault.entity';
import { TransactionsModule } from '../processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../processing-tx/onchain/blockchain.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, Vault]),
    forwardRef(() => TransactionsModule),
    BlockchainModule,
    ConfigModule
  ],
  controllers: [LpTokensController],
  providers: [LpTokensService],
  exports: [LpTokensService],
})
export class LpTokensModule {}
