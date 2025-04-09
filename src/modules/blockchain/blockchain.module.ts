import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlockchainService } from './blockchain.service';
import { BlockchainScannerService } from './blockchain-scanner.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [ConfigModule, TransactionsModule, AssetsModule],
  controllers: [],
  providers: [BlockchainService, BlockchainScannerService],
  exports: [BlockchainService, BlockchainScannerService]
})
export class BlockchainModule {}
