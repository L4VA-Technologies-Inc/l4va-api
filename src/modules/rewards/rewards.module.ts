import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RewardsController } from './rewards.controller';
import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { RewardEventOutbox } from '@/database/rewardEventOutbox.entity';

/**
 * Thin rewards module for l4va-api.
 * Provides RewardEventProducer (writes events to outbox) and
 * RewardClaimProxy (proxies claim operations to l4va-rewards).
 */
@Module({
  imports: [HttpModule, ConfigModule, TypeOrmModule.forFeature([RewardEventOutbox])],
  controllers: [RewardsController],
  providers: [RewardEventProducer, RewardClaimProxy],
  exports: [RewardEventProducer],
})
export class RewardsModule {}
