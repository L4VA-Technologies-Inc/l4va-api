import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RewardAdminController } from './reward-admin.controller';
import { RewardsController } from './rewards.controller';
import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEpochConfigProxy } from './services/reward-epoch-config-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { RewardEventOutbox } from '@/database/rewardEventOutbox.entity';
import { Vault } from '@/database/vault.entity';

/**
 * Rewards module for l4va-api (BFF layer).
 * Provides:
 * - RewardEventProducer: writes events to outbox
 * - RewardClaimProxy: proxies operations to l4va-rewards
 *   - prepareClaim: single call to l4va-rewards /prepare (reserve + build tx)
 *   - submitClaim: single call to l4va-rewards /submit (assemble + submit + confirm)
 *
 * Cardano tx building now lives entirely in l4va-rewards (ClaimTxBuilderService).
 */
@Module({
  imports: [HttpModule, ConfigModule, TypeOrmModule.forFeature([RewardEventOutbox, Vault])],
  controllers: [RewardsController, RewardAdminController],
  providers: [RewardEventProducer, RewardClaimProxy, RewardEpochConfigProxy],
  exports: [RewardEventProducer],
})
export class RewardsModule {}
