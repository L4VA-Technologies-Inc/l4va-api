import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RewardsController } from './rewards.controller';
import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';
import { RewardsClaimTxBuilderService } from './services/rewards-claim-tx-builder.service';

import { RewardEventOutbox } from '@/database/rewardEventOutbox.entity';

/**
 * Rewards module for l4va-api (BFF layer).
 * Provides:
 * - RewardEventProducer: writes events to outbox
 * - RewardClaimProxy: proxies operations to l4va-rewards (which returns clean DTOs)
 * - RewardsClaimTxBuilderService: builds Cardano transactions for claims
 *
 * All transformations are now handled in l4va-rewards service.
 */
@Module({
  imports: [HttpModule, ConfigModule, TypeOrmModule.forFeature([RewardEventOutbox])],
  controllers: [RewardsController],
  providers: [RewardEventProducer, RewardClaimProxy, RewardsClaimTxBuilderService],
  exports: [RewardEventProducer],
})
export class RewardsModule {}
