import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RewardsController } from './rewards.controller';
import { ActivityEventService } from './services/activity-event.service';
import { EpochService } from './services/epoch.service';
import { ScoringService } from './services/scoring.service';

import { RewardActivityEvent } from '@/database/rewardActivityEvent.entity';
import { RewardActivityWeight } from '@/database/rewardActivityWeight.entity';
import { RewardBalanceSnapshot } from '@/database/rewardBalanceSnapshot.entity';
import { RewardClaim } from '@/database/rewardClaim.entity';
import { RewardEpoch } from '@/database/rewardEpoch.entity';
import { RewardLpPosition } from '@/database/rewardLpPosition.entity';
import { RewardScore } from '@/database/rewardScore.entity';
import { RewardVestingPosition } from '@/database/rewardVestingPosition.entity';
import { Vault } from '@/database/vault.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RewardEpoch,
      RewardActivityEvent,
      RewardActivityWeight,
      RewardScore,
      RewardVestingPosition,
      RewardBalanceSnapshot,
      RewardLpPosition,
      RewardClaim,
      Vault,
    ]),
  ],
  controllers: [RewardsController],
  providers: [EpochService, ActivityEventService, ScoringService],
  exports: [ActivityEventService, EpochService, ScoringService],
})
export class RewardsModule {}
