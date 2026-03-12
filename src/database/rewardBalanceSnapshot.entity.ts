import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert, Index, Unique } from 'typeorm';

import { Vault } from './vault.entity';

@Entity('reward_balance_snapshots')
@Unique(['wallet_address', 'vault_id', 'snapshot_date'])
@Index(['wallet_address', 'vault_id'])
export class RewardBalanceSnapshot {
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

  @Expose({ name: 'snapshotDate' })
  @Column({ name: 'snapshot_date', type: 'date' })
  @Index()
  snapshot_date: Date;

  @Expose({ name: 'walletVtBalance' })
  @Column({ name: 'wallet_vt_balance', type: 'bigint', default: 0 })
  wallet_vt_balance: number;

  @Expose({ name: 'lpVtEquivalent' })
  @Column({ name: 'lp_vt_equivalent', type: 'bigint', default: 0 })
  lp_vt_equivalent: number;

  @Expose({ name: 'effectiveBalance' })
  @Column({ name: 'effective_balance', type: 'bigint', default: 0 })
  effective_balance: number;

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
