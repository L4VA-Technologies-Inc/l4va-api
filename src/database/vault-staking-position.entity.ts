import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Vault } from './vault.entity';

export enum VaultStakingPositionStatus {
  PENDING = 'pending',
  STAKED = 'staked',
  HARVESTING = 'harvesting',
  UNSTAKED = 'unstaked',
  FAILED = 'failed',
}

/**
 * Tracks a single Anvil staking position (one Anvil stakeId maps to one position,
 * which may contain multiple NFT assets).
 */
@Entity('vault_staking_positions')
@Index(['vault_id', 'platform'])
@Index(['stake_id', 'platform'], { unique: false })
@Index(['status'])
export class VaultStakingPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'vault_id' })
  vault_id: string;

  @ManyToOne(() => Vault)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'platform', type: 'varchar', length: 64 })
  platform: string;

  @Column({ name: 'stake_collection_id', type: 'int' })
  stake_collection_id: number;

  /** Anvil stake position ID (numeric, stored as varchar for safety) */
  @Column({ name: 'stake_id', type: 'varchar', length: 64, nullable: true })
  stake_id?: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: VaultStakingPositionStatus,
    default: VaultStakingPositionStatus.PENDING,
  })
  status: VaultStakingPositionStatus;

  @Column({ name: 'stake_tx_hash', type: 'varchar', nullable: true })
  stake_tx_hash?: string;

  @Column({ name: 'unstake_tx_hash', type: 'varchar', nullable: true })
  unstake_tx_hash?: string;

  /** Asset IDs (DB UUIDs) that belong to this position */
  @Column({ name: 'asset_ids', type: 'jsonb', default: '[]' })
  asset_ids: string[];

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  started_at?: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  ended_at?: Date;

  /** Raw Anvil stakeAssetsV2 / getStakesV2 response stored for audit */
  @Column({ name: 'raw_stake_response', type: 'jsonb', nullable: true })
  raw_stake_response?: any;

  /** Raw Anvil harvestStakeV2 response stored for audit */
  @Column({ name: 'raw_harvest_response', type: 'jsonb', nullable: true })
  raw_harvest_response?: any;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
