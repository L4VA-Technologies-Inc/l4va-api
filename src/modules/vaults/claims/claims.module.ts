import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomaticCancellationService } from './automatic-cancellation.service';
import { CancellationProcessor } from './cancellation.processor';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { AssetsModule } from '@/modules/vaults/assets/assets.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/offchain-tx/transactions.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/onchain/blockchain.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'cancellationProcessing',
      defaultJobOptions: {
        removeOnComplete: 10,
        removeOnFail: 10,
      },
    }),
    TypeOrmModule.forFeature([Claim, Transaction, Asset]),
    BlockchainModule,
    TransactionsModule,
    HttpModule,
    AssetsModule,
  ],
  controllers: [ClaimsController],
  providers: [ClaimsService, AutomaticCancellationService, CancellationProcessor],
  exports: [ClaimsService],
})
export class ClaimsModule {}
