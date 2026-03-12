import { Expose } from 'class-transformer';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
  Index,
} from 'typeorm';

import { RewardActivityType, VestingPositionStatus } from '../types/rewards.types';

import { RewardEpoch } from './rewardEpoch.entity';
import { Vault } from './vault.entity';

@Entity('reward_vesting_positions')
@Index(['wallet_address', 'vault'])
export class RewardVestingPosition {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => RewardEpoch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'epoch_id' })
  epoch: RewardEpoch;

  @Column({ name: 'epoch_id' })
  @Index()
  epoch_id: string;

  @Expose({ name: 'walletAddress' })
  @Column({ name: 'wallet_address' })
  @Index()
  wallet_address: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id' })
  vault_id: string;

  @Expose({ name: 'activityType' })
  @Column({
    name: 'activity_type',
    type: 'enum',
    enum: RewardActivityType,
  })
  activity_type: RewardActivityType;

  @Expose({ name: 'totalAmount' })
  @Column({ name: 'total_amount', type: 'bigint' })
  total_amount: number;

  @Expose({ name: 'immediateAmount' })
  @Column({ name: 'immediate_amount', type: 'bigint' })
  immediate_amount: number;

  @Expose({ name: 'vestedAmount' })
  @Column({ name: 'vested_amount', type: 'bigint' })
  vested_amount: number;

  @Expose({ name: 'unlockedAmount' })
  @Column({ name: 'unlocked_amount', type: 'bigint', default: 0 })
  unlocked_amount: number;

  @Expose({ name: 'requiredVtBalance' })
  @Column({ name: 'required_vt_balance', type: 'bigint' })
  required_vt_balance: number;

  @Expose({ name: 'holdFactor' })
  @Column({
    name: 'hold_factor',
    type: 'numeric',
    precision: 5,
    scale: 4,
    default: 0,
  })
  hold_factor: number;

  @Expose({ name: 'vestingStart' })
  @Column({ name: 'vesting_start', type: 'timestamptz' })
  vesting_start: Date;

  @Expose({ name: 'vestingEnd' })
  @Column({ name: 'vesting_end', type: 'timestamptz' })
  vesting_end: Date;

  @Expose({ name: 'status' })
  @Column({
    type: 'enum',
    enum: VestingPositionStatus,
    default: VestingPositionStatus.ACTIVE,
  })
  status: VestingPositionStatus;

  @Expose({ name: 'createdAt' })
  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  created_at: Date;

  @Expose({ name: 'updatedAt' })
  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updated_at: Date;

  @BeforeInsert()
  setDate(): void {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  @BeforeUpdate()
  updateDate(): void {
    this.updated_at = new Date();
  }
}
