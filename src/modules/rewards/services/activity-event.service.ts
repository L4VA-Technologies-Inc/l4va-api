import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { RewardActivityEvent } from '@/database/rewardActivityEvent.entity';
import { RewardActivityWeight } from '@/database/rewardActivityWeight.entity';
import { RewardEpoch } from '@/database/rewardEpoch.entity';
import { Vault } from '@/database/vault.entity';
import { DEFAULT_ACTIVITY_WEIGHTS, RewardActivityType } from '@/types/rewards.types';

interface IndexEventInput {
  walletAddress: string;
  vaultId?: string;
  eventType: RewardActivityType;
  assetId?: string;
  txHash?: string;
  units?: number;
  metadata?: Record<string, any>;
}

@Injectable()
export class ActivityEventService {
  private readonly logger = new Logger(ActivityEventService.name);

  /** In-memory cache of activity weights, refreshed on first use or when weights change */
  private weightCache: Map<RewardActivityType, number> | null = null;

  constructor(
    @InjectRepository(RewardActivityEvent)
    private readonly activityEventRepository: Repository<RewardActivityEvent>,
    @InjectRepository(RewardActivityWeight)
    private readonly activityWeightRepository: Repository<RewardActivityWeight>,
    @InjectRepository(RewardEpoch)
    private readonly epochRepository: Repository<RewardEpoch>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {}

  /**
   * Index a new reward activity event into the current epoch.
   * Called by other services whenever a rewardable action occurs.
   */
  async indexEvent(input: IndexEventInput): Promise<RewardActivityEvent | null> {
    try {
      const epoch = await this.getCurrentEpoch();

      if (!epoch) {
        this.logger.warn('No active epoch found вЂ” event not indexed');
        return null;
      }

      const event = this.activityEventRepository.create({
        epoch_id: epoch.id,
        wallet_address: input.walletAddress,
        vault_id: input.vaultId ?? null,
        event_type: input.eventType,
        asset_id: input.assetId ?? null,
        tx_hash: input.txHash ?? null,
        event_timestamp: new Date(),
        units: input.units ?? 1,
        metadata: input.metadata ?? null,
        processed: false,
      });

      const saved = await this.activityEventRepository.save(event);
      this.logger.debug(`Indexed ${input.eventType} event for ${input.walletAddress} in epoch ${epoch.epoch_number}`);
      return saved;
    } catch (error) {
      this.logger.error(`Failed to index event: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * Get all unprocessed events for a given epoch.
   */
  async getUnprocessedEvents(epochId: string): Promise<RewardActivityEvent[]> {
    return this.activityEventRepository.find({
      where: { epoch_id: epochId, processed: false },
      relations: ['vault'],
    });
  }

  /**
   * Mark events as processed after scoring.
   */
  async markEventsProcessed(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.activityEventRepository.update(eventIds, { processed: true });
  }

  /**
   * Get the currently active epoch (active status, current date within range).
   */
  async getCurrentEpoch(): Promise<RewardEpoch | null> {
    const now = new Date();
    return this.epochRepository.findOne({
      where: {
        status: 'active' as any,
        epoch_start: LessThanOrEqual(now),
        epoch_end: MoreThanOrEqual(now),
      },
      order: { epoch_number: 'DESC' },
    });
  }

  /**
   * Get the weight for a given activity type.
   * Uses in-memory cache with DB fallback, then default constants.
   */
  async getWeight(activityType: RewardActivityType): Promise<number> {
    if (!this.weightCache) {
      await this.refreshWeightCache();
    }
    return this.weightCache!.get(activityType) ?? DEFAULT_ACTIVITY_WEIGHTS[activityType] ?? 1;
  }

  /**
   * Get all activity weights as a map.
   */
  async getAllWeights(): Promise<Map<RewardActivityType, number>> {
    if (!this.weightCache) {
      await this.refreshWeightCache();
    }
    return new Map(this.weightCache);
  }

  /**
   * Refresh the in-memory weight cache from DB.
   */
  async refreshWeightCache(): Promise<void> {
    const weights = await this.activityWeightRepository.find({
      where: { active: true },
    });
    this.weightCache = new Map<RewardActivityType, number>();

    // Seed with defaults
    for (const [type, weight] of Object.entries(DEFAULT_ACTIVITY_WEIGHTS)) {
      this.weightCache.set(type as RewardActivityType, weight);
    }

    // Override with DB values
    for (const w of weights) {
      this.weightCache.set(w.activity_type, Number(w.weight));
    }
  }

  /**
   * Update a specific activity weight in the DB and refresh cache.
   */
  async updateWeight(activityType: RewardActivityType, weight: number): Promise<void> {
    await this.activityWeightRepository.upsert({ activity_type: activityType, weight, updated_at: new Date() }, [
      'activity_type',
    ]);
    await this.refreshWeightCache();
  }

  /**
   * Get event counts grouped by type for a given epoch.
   */
  async getEpochEventSummary(epochId: string): Promise<Record<string, number>> {
    const result = await this.activityEventRepository
      .createQueryBuilder('e')
      .select('e.event_type', 'event_type')
      .addSelect('COUNT(*)', 'count')
      .where('e.epoch_id = :epochId', { epochId })
      .groupBy('e.event_type')
      .getRawMany();

    const summary: Record<string, number> = {};
    for (const row of result) {
      summary[row.event_type] = parseInt(row.count, 10);
    }
    return summary;
  }
}
