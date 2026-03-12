import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, OneToMany, BeforeInsert, Index } from 'typeorm';

import { EpochStatus } from '../types/rewards.types';

import { RewardActivityEvent } from './rewardActivityEvent.entity';
import { RewardScore } from './rewardScore.entity';

@Entity('reward_epochs')
export class RewardEpoch {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'epochNumber' })
  @Column({ name: 'epoch_number', type: 'integer', unique: true })
  @Index()
  epoch_number: number;

  @Expose({ name: 'epochStart' })
  @Column({ name: 'epoch_start', type: 'timestamptz' })
  epoch_start: Date;

  @Expose({ name: 'epochEnd' })
  @Column({ name: 'epoch_end', type: 'timestamptz' })
  epoch_end: Date;

  @Expose({ name: 'emissionTotal' })
  @Column({ name: 'emission_total', type: 'bigint', default: 1_000_000 })
  emission_total: number;

  @Expose({ name: 'participantPool' })
  @Column({ name: 'participant_pool', type: 'bigint', default: 800_000 })
  participant_pool: number;

  @Expose({ name: 'creatorPool' })
  @Column({ name: 'creator_pool', type: 'bigint', default: 200_000 })
  creator_pool: number;

  @Expose({ name: 'totalActivityScore' })
  @Column({
    name: 'total_activity_score',
    type: 'numeric',
    precision: 30,
    scale: 6,
    default: 0,
  })
  total_activity_score: number;

  @Expose({ name: 'status' })
  @Column({
    type: 'enum',
    enum: EpochStatus,
    default: EpochStatus.ACTIVE,
  })
  status: EpochStatus;

  @OneToMany(() => RewardActivityEvent, event => event.epoch)
  activity_events: RewardActivityEvent[];

  @OneToMany(() => RewardScore, score => score.epoch)
  scores: RewardScore[];

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
