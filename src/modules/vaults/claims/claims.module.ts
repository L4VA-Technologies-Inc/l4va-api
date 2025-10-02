import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { AssetsModule } from '@/modules/vaults//processing-tx/assets/assets.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Claim, Transaction]),
    BlockchainModule,
    TransactionsModule,
    HttpModule,
    AssetsModule,
  ],
  controllers: [ClaimsController],
  providers: [ClaimsService, BlockchainService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
