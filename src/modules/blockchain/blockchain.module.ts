import { Module } from '@nestjs/common';
import { BlockchainService } from './blockchain.service';
import {TransactionsModule} from '../transactions/transactions.module';

@Module({
  imports: [TransactionsModule],
  controllers: [],
  providers: [BlockchainService],
  exports: [BlockchainService]
})
export class BlockchainModule {}
