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

import { LpPoolType } from '../types/rewards.types';

import { Vault } from './vault.entity';

@Entity('reward_lp_positions')
@Unique(['wallet_address', 'vault_id', 'pool_type', 'dex'])
@Index(['wallet_address', 'vault_id'])
export class RewardLpPosition {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'walletAddress' })
  @Column({ name: 'wallet_address' })
  @Index()
  wallet_address: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id' })
  vault_id: string;

  @Expose({ name: 'poolType' })
  @Column({
    name: 'pool_type',
    type: 'enum',
    enum: LpPoolType,
  })
  pool_type: LpPoolType;

  @Expose({ name: 'dex' })
  @Column({ type: 'varchar' })
  dex: string;

  @Expose({ name: 'lpTokens' })
  @Column({ name: 'lp_tokens', type: 'bigint', default: 0 })
  lp_tokens: number;

  @Expose({ name: 'vtInPool' })
  @Column({ name: 'vt_in_pool', type: 'bigint', default: 0 })
  vt_in_pool: number;

  @Expose({ name: 'vtUserEquivalent' })
  @Column({ name: 'vt_user_equivalent', type: 'bigint', default: 0 })
  vt_user_equivalent: number;

  @Expose({ name: 'positionAgeSeconds' })
  @Column({ name: 'position_age_seconds', type: 'integer', default: 0 })
  position_age_seconds: number;

  @Expose({ name: 'firstDetected' })
  @Column({ name: 'first_detected', type: 'timestamptz' })
  first_detected: Date;

  @Expose({ name: 'lastUpdated' })
  @Column({
    name: 'last_updated',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  last_updated: Date;

  @BeforeInsert()
  setDate(): void {
    const now = new Date();
    this.first_detected = this.first_detected || now;
    this.last_updated = now;
  }

  @BeforeUpdate()
  updateDate(): void {
    this.last_updated = new Date();
  }
}
