import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert, Index } from 'typeorm';

import { RewardActivityType } from '../types/rewards.types';

import { RewardEpoch } from './rewardEpoch.entity';
import { Vault } from './vault.entity';

@Entity('reward_activity_events')
@Index(['epoch', 'wallet_address'])
@Index(['wallet_address', 'vault'])
export class RewardActivityEvent {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RewardEpoch, epoch => epoch.activity_events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'epoch_id' })
  epoch: RewardEpoch;

  @Column({ name: 'epoch_id' })
  @Index()
  epoch_id: string;

  @Expose({ name: 'walletAddress' })
  @Column({ name: 'wallet_address' })
  @Index()
  wallet_address: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', nullable: true })
  @Index()
  vault_id: string;

  @Expose({ name: 'eventType' })
  @Column({
    name: 'event_type',
    type: 'enum',
    enum: RewardActivityType,
  })
  @Index()
  event_type: RewardActivityType;

  @Expose({ name: 'assetId' })
  @Column({ name: 'asset_id', nullable: true })
  asset_id: string;

  @Expose({ name: 'txHash' })
  @Column({ name: 'tx_hash', nullable: true })
  tx_hash: string;

  @Expose({ name: 'eventTimestamp' })
  @Column({ name: 'event_timestamp', type: 'timestamptz' })
  event_timestamp: Date;

  @Expose({ name: 'units' })
  @Column({ type: 'numeric', precision: 20, scale: 6, default: 1 })
  units: number;

  @Expose({ name: 'metadata' })
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Expose({ name: 'processed' })
  @Column({ type: 'boolean', default: false })
  @Index()
  processed: boolean;

  @Expose({ name: 'createdAt' })
  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at: Date;

  @BeforeInsert()
  setDate(): void {
    this.created_at = new Date();
  }
}
