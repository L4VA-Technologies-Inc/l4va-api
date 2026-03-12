import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert, Index, Unique } from 'typeorm';

import { ScoreBreakdown } from '../types/rewards.types';

import { RewardEpoch } from './rewardEpoch.entity';

@Entity('reward_scores')
@Unique(['epoch_id', 'wallet_address'])
export class RewardScore {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RewardEpoch, epoch => epoch.scores, {
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

  @Expose({ name: 'activityScore' })
  @Column({
    name: 'activity_score',
    type: 'numeric',
    precision: 30,
    scale: 6,
    default: 0,
  })
  activity_score: number;

  @Expose({ name: 'alignmentMultiplier' })
  @Column({
    name: 'alignment_multiplier',
    type: 'numeric',
    precision: 4,
    scale: 2,
    default: 1.0,
  })
  alignment_multiplier: number;

  @Expose({ name: 'baseReward' })
  @Column({ name: 'base_reward', type: 'bigint', default: 0 })
  base_reward: number;

  @Expose({ name: 'finalReward' })
  @Column({ name: 'final_reward', type: 'bigint', default: 0 })
  final_reward: number;

  @Expose({ name: 'wasCapped' })
  @Column({ name: 'was_capped', type: 'boolean', default: false })
  was_capped: boolean;

  @Expose({ name: 'metadata' })
  @Column({ type: 'jsonb', nullable: true })
  metadata: ScoreBreakdown;

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
