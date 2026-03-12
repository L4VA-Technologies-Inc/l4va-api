import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RewardEpoch } from '@/database/rewardEpoch.entity';
import { EpochStatus, REWARDS_CONSTANTS } from '@/types/rewards.types';

@Injectable()
export class EpochService {
  private readonly logger = new Logger(EpochService.name);

  constructor(
    @InjectRepository(RewardEpoch)
    private readonly epochRepository: Repository<RewardEpoch>
  ) {}

  /**
   * Get the current active epoch.
   */
  async getCurrentEpoch(): Promise<RewardEpoch | null> {
    return this.epochRepository.findOne({
      where: { status: EpochStatus.ACTIVE },
      order: { epoch_number: 'DESC' },
    });
  }

  /**
   * Get epoch by ID.
   */
  async getEpochById(id: string): Promise<RewardEpoch | null> {
    return this.epochRepository.findOne({ where: { id } });
  }

  /**
   * Get the latest epoch regardless of status.
   */
  async getLatestEpoch(): Promise<RewardEpoch | null> {
    return this.epochRepository.findOne({
      order: { epoch_number: 'DESC' },
    });
  }

  /**
   * List all epochs ordered by epoch_number DESC.
   */
  async listEpochs(limit = 20, offset = 0): Promise<{ epochs: RewardEpoch[]; total: number }> {
    const [epochs, total] = await this.epochRepository.findAndCount({
      order: { epoch_number: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { epochs, total };
  }

  /**
   * Create the very first epoch (run once during system bootstrap).
   * The epoch starts now and ends in 7 days.
   */
  async bootstrapFirstEpoch(): Promise<RewardEpoch> {
    const existing = await this.getLatestEpoch();
    if (existing) {
      this.logger.warn(`Epoch system already bootstrapped. Latest epoch: #${existing.epoch_number}`);
      return existing;
    }

    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + REWARDS_CONSTANTS.EPOCH_DURATION_DAYS);

    const epoch = this.epochRepository.create({
      epoch_number: 1,
      epoch_start: now,
      epoch_end: end,
      emission_total: REWARDS_CONSTANTS.WEEKLY_EMISSION,
      participant_pool: REWARDS_CONSTANTS.PARTICIPANT_POOL,
      creator_pool: REWARDS_CONSTANTS.CREATOR_POOL,
      status: EpochStatus.ACTIVE,
    });

    const saved = await this.epochRepository.save(epoch);
    this.logger.log(`Bootstrapped epoch #1: ${now.toISOString()} в†’ ${end.toISOString()}`);
    return saved;
  }

  /**
   * Create the next epoch from the previous one.
   */
  async createNextEpoch(previousEpoch: RewardEpoch): Promise<RewardEpoch> {
    const nextNumber = previousEpoch.epoch_number + 1;

    if (nextNumber > REWARDS_CONSTANTS.TOTAL_WEEKS) {
      this.logger.warn(
        `Epoch #${nextNumber} exceeds program duration (${REWARDS_CONSTANTS.TOTAL_WEEKS} weeks). No new epoch created.`
      );
      return previousEpoch;
    }

    const start = new Date(previousEpoch.epoch_end);
    const end = new Date(start);
    end.setDate(end.getDate() + REWARDS_CONSTANTS.EPOCH_DURATION_DAYS);

    const epoch = this.epochRepository.create({
      epoch_number: nextNumber,
      epoch_start: start,
      epoch_end: end,
      emission_total: REWARDS_CONSTANTS.WEEKLY_EMISSION,
      participant_pool: REWARDS_CONSTANTS.PARTICIPANT_POOL,
      creator_pool: REWARDS_CONSTANTS.CREATOR_POOL,
      status: EpochStatus.ACTIVE,
    });

    const saved = await this.epochRepository.save(epoch);
    this.logger.log(`Created epoch #${nextNumber}: ${start.toISOString()} в†’ ${end.toISOString()}`);
    return saved;
  }

  /**
   * Transition an epoch to PROCESSING status.
   */
  async markProcessing(epochId: string): Promise<void> {
    await this.epochRepository.update(epochId, {
      status: EpochStatus.PROCESSING,
    });
  }

  /**
   * Transition an epoch to COMPLETED status with total scores.
   */
  async markCompleted(epochId: string, totalActivityScore: number): Promise<void> {
    await this.epochRepository.update(epochId, {
      status: EpochStatus.COMPLETED,
      total_activity_score: totalActivityScore,
    });
  }

  /**
   * Weekly cron: Check if the current epoch has ended and trigger rotation.
   * Runs every hour to detect epoch boundaries.
   * The actual scoring is triggered by the ScoringService.
   */
  @Cron(CronExpression.EVERY_HOUR) // Every hour
  async checkEpochRotation(): Promise<void> {
    const current = await this.getCurrentEpoch();
    if (!current) {
      this.logger.debug('No active epoch found');
      return;
    }

    const now = new Date();
    if (now < new Date(current.epoch_end)) {
      return; // Epoch still running
    }

    this.logger.log(`Epoch #${current.epoch_number} has ended at ${current.epoch_end}. Triggering processing...`);
    // The ScoringService listens and processes via processEpochEnd
  }
}
