import { Module } from '@nestjs/common';

import { CardanoBuybackController } from './cardano-buyback.controller';
import { CardanoBuybackService } from './cardano-buyback.service';

import { DexHunterModule } from '@/modules/dexhunter/dexhunter.module';
import { RedisModule } from '@/modules/redis/redis.module';
import { BlockchainModule } from '@/modules/vaults/processing-tx/blockchain.module';
import { TransactionsModule } from '@/modules/vaults/processing-tx/transactions/transactions.module';

@Module({
  imports: [DexHunterModule, BlockchainModule, TransactionsModule, RedisModule],
  controllers: [CardanoBuybackController],
  providers: [CardanoBuybackService],
})
export class CardanoBuybackModule {}
