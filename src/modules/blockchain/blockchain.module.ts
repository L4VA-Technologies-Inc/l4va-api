import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlockchainService } from './blockchain.service';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { BlockchainTransactionService } from './blockchain-transaction.service';
import { BlockchainController } from './blockchain.controller';
import { AnvilApiService } from './anvil-api.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [ConfigModule, TransactionsModule, AssetsModule],
  controllers: [BlockchainController],
  providers: [
    BlockchainService,
    BlockchainScannerService,
    BlockchainTransactionService,
    AnvilApiService
  ],
  exports: [
    BlockchainService,
    BlockchainScannerService,
    BlockchainTransactionService
  ]
})
export class BlockchainModule {}
