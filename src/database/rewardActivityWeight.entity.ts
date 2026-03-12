import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, Unique } from 'typeorm';

import { RewardActivityType } from '../types/rewards.types';

@Entity('reward_activity_weights')
@Unique(['activity_type'])
export class RewardActivityWeight {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'activityType' })
  @Column({
    name: 'activity_type',
    type: 'enum',
    enum: RewardActivityType,
    unique: true,
  })
  activity_type: RewardActivityType;

  @Expose({ name: 'weight' })
  @Column({ type: 'numeric', precision: 10, scale: 4, default: 1.0 })
  weight: number;

  @Expose({ name: 'description' })
  @Column({ type: 'text', nullable: true })
  description: string;

  @Expose({ name: 'active' })
  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Expose({ name: 'updatedAt' })
  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updated_at: Date;
}
