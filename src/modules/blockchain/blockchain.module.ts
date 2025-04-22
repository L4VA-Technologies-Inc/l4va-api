import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlockchainService } from './blockchain.service';
import { BlockchainTransactionService } from './blockchain-transaction.service';
import { BlockchainController } from './blockchain.controller';
import { AnvilApiService } from './anvil-api.service';
import { WebhookVerificationService } from './webhook-verification.service';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [ConfigModule, TransactionsModule],
  controllers: [BlockchainController],
  providers: [
    BlockchainService,
    BlockchainTransactionService,
    AnvilApiService,
    WebhookVerificationService
  ],
  exports: [
    BlockchainService,
    BlockchainTransactionService,
    WebhookVerificationService
  ]
})
export class BlockchainModule {}
