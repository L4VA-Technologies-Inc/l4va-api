import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RewardsController } from './rewards.controller';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { RewardEventOutbox } from '@/database/rewardEventOutbox.entity';

/**
 * Thin rewards module for l4va-api.
 * Only provides RewardEventProducer (writes events to outbox).
 * All processing lives in l4va-rewards.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RewardEventOutbox]),
  ],
  controllers: [RewardsController],
  providers: [RewardEventProducer],
  exports: [RewardEventProducer],
})
export class RewardsModule {}
