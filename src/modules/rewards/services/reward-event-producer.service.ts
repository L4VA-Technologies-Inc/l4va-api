import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { RewardEventOutbox } from '@/database/rewardEventOutbox.entity';
import { RewardActivityType } from '@/types/rewards.types';

interface IndexEventInput {
  walletAddress: string;
  vaultId?: string;
  eventType: RewardActivityType;
  assetId?: string;
  txHash?: string;
  units?: number;
  metadata?: Record<string, any>;
}

/**
 * Thin event producer: writes reward events to the outbox table.
 * l4va-rewards polls the outbox and processes events into activity_events.
 */
@Injectable()
export class RewardEventProducer {
  private readonly logger = new Logger(RewardEventProducer.name);

  constructor(
    @InjectRepository(RewardEventOutbox)
    private readonly outboxRepository: Repository<RewardEventOutbox>
  ) {}

  /**
   * Write a reward event to the outbox for l4va-rewards to pick up.
   * Called by other services whenever a rewardable action occurs.
   */
  async indexEvent(input: IndexEventInput): Promise<RewardEventOutbox | null> {
    try {
      const event = this.outboxRepository.create({
        wallet_address: input.walletAddress,
        vault_id: input.vaultId ?? null,
        event_type: input.eventType,
        asset_id: input.assetId ?? null,
        tx_hash: input.txHash ?? null,
        event_timestamp: new Date(),
        units: input.units ?? 1,
        metadata: input.metadata ?? null,
      });

      const saved = await this.outboxRepository.save(event);
      this.logger.debug(`Outbox: ${input.eventType} event for ${input.walletAddress}`);
      return saved;
    } catch (error) {
      this.logger.error(`Failed to write outbox event: ${error.message}`, error.stack);
      return null;
    }
  }
}
