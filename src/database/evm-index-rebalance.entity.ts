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

import {
  IndexRebalanceLeg,
  IndexRebalanceStatus,
  IndexRebalanceTrigger,
  IndexTarget,
} from '../types/index-vault.types';

import { Vault } from './vault.entity';

export enum IndexRebalancePhase {
  sells = 'sells',
  buys = 'buys',
  done = 'done',
}

/**
 * One basket rebalance of an index-weighted vault: the initial buy after a
 * cycle locks, or the market-clearing trades of a passed re-weight proposal.
 *
 * Legs are persisted before they are sent. Each leg's `operationId` is derived
 * from (vault, idempotency_key, leg index), and the vault refuses a used id, so
 * resuming a run after a crash can never trade the same leg twice — a leg whose
 * receipt was lost is adopted via `isSwapOperationIdUsed`.
 */
@Entity('evm_index_rebalances')
@Index(['vault_id', 'idempotency_key'], { unique: true })
@Index(['vault_id', 'created_at'])
export class EvmIndexRebalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  /** `initial:cycle:<cycleId>` or `proposal:<proposalId>`. */
  @Column({ name: 'idempotency_key', type: 'varchar' })
  idempotency_key: string;

  @Column({ name: 'trigger', type: 'varchar' })
  trigger: IndexRebalanceTrigger;

  @Column({ name: 'proposal_id', type: 'uuid', nullable: true })
  proposal_id?: string | null;

  @Column({ name: 'status', type: 'varchar', default: IndexRebalanceStatus.pending })
  status: IndexRebalanceStatus;

  @Column({ name: 'phase', type: 'varchar', default: IndexRebalancePhase.sells })
  phase: IndexRebalancePhase;

  /** Basket the run trades toward, frozen at creation. */
  @Column({ name: 'targets', type: 'jsonb' })
  targets: IndexTarget[];

  @Column({ name: 'reserve_bps', type: 'integer' })
  reserve_bps: number;

  /** NAV in wei when the run was first planned. Informational. */
  @Column({ name: 'nav_native', type: 'numeric', precision: 78, scale: 0, nullable: true })
  nav_native?: string | null;

  @Column({ name: 'legs', type: 'jsonb', default: () => "'[]'" })
  legs: IndexRebalanceLeg[];

  @Column({ name: 'attempts', type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  last_error?: string | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completed_at?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
