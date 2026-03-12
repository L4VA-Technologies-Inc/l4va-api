import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ActivityEventService } from './activity-event.service';
import { EpochService } from './epoch.service';

import { RewardActivityEvent } from '@/database/rewardActivityEvent.entity';
import { RewardClaim } from '@/database/rewardClaim.entity';
import { RewardEpoch } from '@/database/rewardEpoch.entity';
import { RewardScore } from '@/database/rewardScore.entity';
import { RewardVestingPosition } from '@/database/rewardVestingPosition.entity';
import { Vault } from '@/database/vault.entity';
import {
  RewardActivityType,
  REWARDS_CONSTANTS,
  ScoreBreakdown,
  VESTING_ACTIVITIES,
  VestingPositionStatus,
} from '@/types/rewards.types';

interface WalletEventGroup {
  walletAddress: string;
  events: RewardActivityEvent[];
}

interface WalletScoreResult {
  walletAddress: string;
  activityScore: number;
  breakdown: ScoreBreakdown;
  vestingEvents: RewardActivityEvent[];
}

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    @InjectRepository(RewardScore)
    private readonly scoreRepository: Repository<RewardScore>,
    @InjectRepository(RewardClaim)
    private readonly claimRepository: Repository<RewardClaim>,
    @InjectRepository(RewardVestingPosition)
    private readonly vestingRepository: Repository<RewardVestingPosition>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly activityEventService: ActivityEventService,
    private readonly epochService: EpochService
  ) {}

  /**
   * Hourly cron: check if the epoch has ended and process it.
   */
  @Cron(CronExpression.EVERY_5_MINUTES) // 5 minutes past every hour (offset from epoch rotation check)
  async checkAndProcessEpochEnd(): Promise<void> {
    const current = await this.epochService.getCurrentEpoch();
    if (!current) return;

    const now = new Date();
    if (now < new Date(current.epoch_end)) return;

    await this.processEpochEnd(current);
  }

  /**
   * Main epoch processing pipeline.
   * Steps 1-10 from the spec's "Reward Engine Execution Flow".
   */
  async processEpochEnd(epoch: RewardEpoch): Promise<void> {
    this.logger.log(`=== Processing epoch #${epoch.epoch_number} ===`);

    try {
      // Step 1: Mark epoch as processing
      await this.epochService.markProcessing(epoch.id);

      // Step 2: Get all unprocessed events
      const events = await this.activityEventService.getUnprocessedEvents(epoch.id);
      if (events.length === 0) {
        this.logger.log('No activity events in this epoch. Finalizing...');
        await this.epochService.markCompleted(epoch.id, 0);
        await this.epochService.createNextEpoch(epoch);
        return;
      }

      this.logger.log(`Processing ${events.length} activity events`);

      // Step 3: Group events by wallet
      const walletGroups = this.groupEventsByWallet(events);

      // Step 4: Calculate activity scores per wallet
      const weights = await this.activityEventService.getAllWeights();
      const walletScores: WalletScoreResult[] = [];

      for (const group of walletGroups) {
        const result = await this.calculateWalletScore(group, weights);
        walletScores.push(result);
      }

      // Step 5: Calculate total scores
      const totalActivityScore = walletScores.reduce((sum, ws) => sum + ws.activityScore, 0);

      if (totalActivityScore === 0) {
        this.logger.warn('Total activity score is 0. Finalizing epoch with no distributions.');
        await this.epochService.markCompleted(epoch.id, 0);
        await this.epochService.createNextEpoch(epoch);
        return;
      }

      // Step 6-8: Compute rewards, apply alignment & cap, store scores
      const scores: Partial<RewardScore>[] = [];
      const claims: Partial<RewardClaim>[] = [];
      const vestingPositions: Partial<RewardVestingPosition>[] = [];

      for (const ws of walletScores) {
        // Base reward (participant pool only вЂ” creator pool handled separately)
        const baseReward = (REWARDS_CONSTANTS.PARTICIPANT_POOL * ws.activityScore) / totalActivityScore;

        // Alignment multiplier (staking skipped for now вЂ” always 1.0)
        const alignmentMultiplier = 1.0;

        // Apply multiplier
        const adjustedReward = baseReward * alignmentMultiplier;

        // Apply 5% wallet cap
        const finalReward = Math.min(adjustedReward, REWARDS_CONSTANTS.MAX_WALLET_REWARD);
        const wasCapped = adjustedReward > REWARDS_CONSTANTS.MAX_WALLET_REWARD;

        // Store score
        scores.push({
          epoch_id: epoch.id,
          wallet_address: ws.walletAddress,
          activity_score: ws.activityScore,
          alignment_multiplier: alignmentMultiplier,
          base_reward: Math.floor(baseReward),
          final_reward: Math.floor(finalReward),
          was_capped: wasCapped,
          metadata: ws.breakdown,
        });

        // Determine vesting split
        const hasVestingActivity = ws.vestingEvents.length > 0;

        let immediateAmount: number;
        let vestedAmount: number;

        if (hasVestingActivity) {
          // 50% immediate / 50% vested
          immediateAmount = Math.floor(finalReward * REWARDS_CONSTANTS.VESTING_IMMEDIATE_RATIO);
          vestedAmount = Math.floor(finalReward * REWARDS_CONSTANTS.VESTING_LOCKED_RATIO);
        } else {
          // All immediate (no vesting-triggering activities)
          immediateAmount = Math.floor(finalReward);
          vestedAmount = 0;
        }

        // Create claimable reward
        claims.push({
          epoch_id: epoch.id,
          wallet_address: ws.walletAddress,
          reward_amount: Math.floor(finalReward),
          immediate_amount: immediateAmount,
          vested_amount: vestedAmount,
        });

        // Create vesting positions per vault for vesting activities
        if (hasVestingActivity) {
          const vestingByVault = this.groupVestingEventsByVault(ws.vestingEvents);
          const epochEnd = new Date(epoch.epoch_end);
          const vestingEnd = new Date(epochEnd);
          vestingEnd.setDate(vestingEnd.getDate() + REWARDS_CONSTANTS.VESTING_PERIOD_DAYS);

          for (const [vaultId, vaultEvents] of vestingByVault) {
            // Calculate the portion of vested amount for this vault
            const vaultVestingScore = vaultEvents.reduce((sum, e) => sum + Number(e.units), 0);
            const totalVestingScore = ws.vestingEvents.reduce((sum, e) => sum + Number(e.units), 0);
            const vaultVestedAmount =
              totalVestingScore > 0 ? Math.floor(vestedAmount * (vaultVestingScore / totalVestingScore)) : 0;

            if (vaultVestedAmount <= 0) continue;

            // Required VT balance = total units purchased/acquired in this vault
            const requiredVtBalance = Math.floor(vaultVestingScore);

            vestingPositions.push({
              epoch_id: epoch.id,
              wallet_address: ws.walletAddress,
              vault_id: vaultId,
              activity_type: vaultEvents[0].event_type,
              total_amount: vaultVestedAmount * 2, // total = immediate + vested
              immediate_amount: vaultVestedAmount, // matching vested
              vested_amount: vaultVestedAmount,
              required_vt_balance: requiredVtBalance,
              vesting_start: epochEnd,
              vesting_end: vestingEnd,
              status: VestingPositionStatus.ACTIVE,
            });
          }
        }
      }

      // Step 9: Batch save all results
      await this.scoreRepository.save(scores as RewardScore[]);
      await this.claimRepository.save(claims as RewardClaim[]);
      if (vestingPositions.length > 0) {
        await this.vestingRepository.save(vestingPositions as RewardVestingPosition[]);
      }

      // Step 10: Mark events processed
      const eventIds = events.map(e => e.id);
      await this.activityEventService.markEventsProcessed(eventIds);

      // Finalize epoch
      await this.epochService.markCompleted(epoch.id, totalActivityScore);
      this.logger.log(
        `Epoch #${epoch.epoch_number} processed: ${walletScores.length} wallets, ` +
          `total score ${totalActivityScore.toFixed(2)}, ${vestingPositions.length} vesting positions`
      );

      // Create next epoch
      await this.epochService.createNextEpoch(epoch);
    } catch (error) {
      this.logger.error(`Failed to process epoch #${epoch.epoch_number}: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Calculate the activity score for a single wallet's events in an epoch.
   */
  private async calculateWalletScore(
    group: WalletEventGroup,
    weights: Map<RewardActivityType, number>
  ): Promise<WalletScoreResult> {
    const breakdown: ScoreBreakdown = {};
    let totalScore = 0;
    const vestingEvents: RewardActivityEvent[] = [];

    // Pre-fetch vault weights for vaults in this wallet's events
    const vaultIds = [...new Set(group.events.filter(e => e.vault_id).map(e => e.vault_id))];
    const vaultWeightMap = new Map<string, number>();
    if (vaultIds.length > 0) {
      const vaults = await this.vaultRepository.find({
        where: vaultIds.map(id => ({ id })),
        select: ['id', 'vault_weight'],
      });
      for (const v of vaults) {
        vaultWeightMap.set(v.id, Number(v.vault_weight) || 1.0);
      }
    }

    // Group events by type
    const eventsByType = new Map<RewardActivityType, RewardActivityEvent[]>();
    for (const event of group.events) {
      const list = eventsByType.get(event.event_type) || [];
      list.push(event);
      eventsByType.set(event.event_type, list);

      // Track vesting-triggering events
      if (VESTING_ACTIVITIES.has(event.event_type)) {
        vestingEvents.push(event);
      }
    }

    // Calculate score per activity type
    for (const [eventType, events] of eventsByType) {
      const weight = weights.get(eventType) ?? 1;
      let typeScore = 0;

      for (const event of events) {
        const units = Number(event.units) || 1;
        const vaultWeight = event.vault_id ? (vaultWeightMap.get(event.vault_id) ?? 1.0) : 1.0;

        // Apply vault weight only on contribution-type activities
        const usesVaultWeight = [
          RewardActivityType.ASSET_CONTRIBUTION,
          RewardActivityType.EXPANSION_ASSET_CONTRIBUTION,
        ].includes(eventType);

        const score = usesVaultWeight ? units * weight * vaultWeight : units * weight;

        typeScore += score;
      }

      breakdown[eventType] = typeScore;
      totalScore += typeScore;
    }

    return {
      walletAddress: group.walletAddress,
      activityScore: totalScore,
      breakdown,
      vestingEvents,
    };
  }

  /**
   * Group events by wallet address.
   */
  private groupEventsByWallet(events: RewardActivityEvent[]): WalletEventGroup[] {
    const map = new Map<string, RewardActivityEvent[]>();
    for (const event of events) {
      const list = map.get(event.wallet_address) || [];
      list.push(event);
      map.set(event.wallet_address, list);
    }
    return Array.from(map.entries()).map(([walletAddress, events]) => ({
      walletAddress,
      events,
    }));
  }

  /**
   * Group vesting events by vault_id.
   */
  private groupVestingEventsByVault(events: RewardActivityEvent[]): Map<string, RewardActivityEvent[]> {
    const map = new Map<string, RewardActivityEvent[]>();
    for (const event of events) {
      if (!event.vault_id) continue;
      const list = map.get(event.vault_id) || [];
      list.push(event);
      map.set(event.vault_id, list);
    }
    return map;
  }

  /**
   * Get score summary for a specific wallet in the current epoch.
   */
  async getWalletCurrentScore(walletAddress: string): Promise<{
    epoch: RewardEpoch | null;
    eventCount: number;
    estimatedScore: number;
  }> {
    const epoch = await this.epochService.getCurrentEpoch();
    if (!epoch) return { epoch: null, eventCount: 0, estimatedScore: 0 };

    const events = await this.activityEventService.getUnprocessedEvents(epoch.id);
    const walletEvents = events.filter(e => e.wallet_address === walletAddress);

    if (walletEvents.length === 0) {
      return { epoch, eventCount: 0, estimatedScore: 0 };
    }

    const weights = await this.activityEventService.getAllWeights();
    const result = await this.calculateWalletScore({ walletAddress, events: walletEvents }, weights);

    return {
      epoch,
      eventCount: walletEvents.length,
      estimatedScore: result.activityScore,
    };
  }

  /**
   * Get historical scores for a wallet.
   */
  async getWalletScoreHistory(
    walletAddress: string,
    limit = 20,
    offset = 0
  ): Promise<{ scores: RewardScore[]; total: number }> {
    const [scores, total] = await this.scoreRepository.findAndCount({
      where: { wallet_address: walletAddress },
      relations: ['epoch'],
      order: { created_at: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { scores, total };
  }
}
