import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

import { RewardActivityType } from '../types/rewards.types';

export enum OutboxStatus {
  PENDING = 'pending',
  PROCESSED = 'processed',
  FAILED = 'failed',
}

@Entity('reward_event_outbox')
export class RewardEventOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'wallet_address' })
  @Index()
  wallet_address: string;

  @Column({ name: 'vault_id', nullable: true })
  vault_id: string;

  @Column({
    name: 'event_type',
    type: 'enum',
    enum: RewardActivityType,
  })
  @Index()
  event_type: RewardActivityType;

  @Column({ name: 'asset_id', nullable: true })
  asset_id: string;

  @Column({ name: 'tx_hash', nullable: true })
  tx_hash: string;

  @Column({ name: 'event_timestamp', type: 'timestamptz' })
  event_timestamp: Date;

  @Column({ name: 'units', type: 'numeric', precision: 20, scale: 6, default: 1 })
  units: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({
    type: 'enum',
    enum: OutboxStatus,
    default: OutboxStatus.PENDING,
  })
  @Index()
  status: OutboxStatus;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processed_at: Date;
}
