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
  Unique,
} from 'typeorm';

import { RewardClaimStatus } from '../types/rewards.types';

import { RewardEpoch } from './rewardEpoch.entity';

@Entity('reward_claims')
@Unique(['epoch_id', 'wallet_address'])
export class RewardClaim {
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

  @Expose({ name: 'rewardAmount' })
  @Column({ name: 'reward_amount', type: 'bigint', default: 0 })
  reward_amount: number;

  @Expose({ name: 'immediateAmount' })
  @Column({ name: 'immediate_amount', type: 'bigint', default: 0 })
  immediate_amount: number;

  @Expose({ name: 'vestedAmount' })
  @Column({ name: 'vested_amount', type: 'bigint', default: 0 })
  vested_amount: number;

  @Expose({ name: 'status' })
  @Column({
    type: 'enum',
    enum: RewardClaimStatus,
    default: RewardClaimStatus.AVAILABLE,
  })
  status: RewardClaimStatus;

  @Expose({ name: 'claimTxHash' })
  @Column({ name: 'claim_tx_hash', nullable: true })
  claim_tx_hash: string;

  @Expose({ name: 'claimedAt' })
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimed_at: Date;

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
