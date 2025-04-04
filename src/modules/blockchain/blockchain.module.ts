import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import {TransactionsModule} from '../transactions/transactions.module';
import {AssetsModule} from '../assets/assets.module';

@Module({
  imports: [TransactionsModule, AssetsModule],
  controllers: [],
  providers: [BlockchainService],
  exports: [BlockchainService]
})
export class BlockchainModule {}
