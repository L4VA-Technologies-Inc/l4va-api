import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TransactionsModule } from '../vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '../vaults/processing-tx/onchain/blockchain.module';
import { BlockchainService } from '../vaults/processing-tx/onchain/blockchain.service';

import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim, User, Transaction, Vault]),
    BlockchainModule,
    TransactionsModule,
    HttpModule,
  ],
  controllers: [ClaimsController],
  providers: [ClaimsService, BlockchainService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
