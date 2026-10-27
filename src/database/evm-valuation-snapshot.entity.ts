import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ColumnBigintStringTransformer } from './column-bigint-string.transformer';
import { EvmAllocation } from './evm-allocation.entity';
import { EvmContributionValuation } from './evm-contribution-valuation.entity';
import { Vault } from './vault.entity';

/**
 * State machine for `EvmValuationSnapshot.status`.
 *
 *   calculated              — compute finished; all inputs + outputs persisted; no on-chain action yet.
 *   ready                   — sanity checks passed; snapshot is broadcast-eligible.
 *   submitting              — atomic gate flipped from ready; broadcast in flight, hash not yet persisted.
 *                             Only lives inside a single call frame (see EvmCycleCloseService).
 *   submitted               — closeCycle tx broadcast and hash persisted; awaiting receipt.
 *   confirmed               — receipt confirmed AND decoded CycleClosed exactly matches the snapshot.
 *   reconciliation_required — receipt successful BUT expected events missing or mismatched. Tx hash stored;
 *                             `reconcileFromChain` re-reads on-chain root before promoting/failing.
 *   failed                  — simulate revert, receipt reverted, or reconciliation concluded mismatch.
 */
export enum EvmSnapshotStatus {
  calculated = 'calculated',
  ready = 'ready',
  submitting = 'submitting',
  submitted = 'submitted',
  confirmed = 'confirmed',
  reconciliation_required = 'reconciliation_required',
  failed = 'failed',
}

/**
 * Full auditable snapshot of a vault's allocation at cycle close.
 * Persisted atomically BEFORE any on-chain broadcast.
 *
 * One row per (vault_id, cycle_id) — enforced by unique constraint.
 * See migration 1785200000000-AddEvmClaimRefundFoundations.
 */
@Entity('evm_valuation_snapshots')
@Index(['vault_id', 'cycle_id'], { unique: true })
export class EvmValuationSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  @Column({ name: 'cycle_id', type: 'bigint' })
  cycle_id: string;

  /** Bumped when calculator or Merkle leaf format changes. */
  @Column({ name: 'schema_version', type: 'integer', default: 1 })
  schema_version: number;

  /** `{ [asset]: 'chainlink:0x…' | 'dexhunter' | 'manual' | ... }` */
  @Column({ name: 'price_source', type: 'jsonb' })
  price_source: Record<string, string>;

  @Column({ name: 'price_timestamp', type: 'timestamptz' })
  price_timestamp: Date;

  /** As pulled from the source, unnormalized. */
  @Column({ name: 'raw_prices', type: 'jsonb' })
  raw_prices: Record<string, unknown>;

  /** Normalized to unit-native (wei per unit). */
  @Column({ name: 'normalized_prices', type: 'jsonb' })
  normalized_prices: Record<string, string>;

  @Column({
    name: 'total_native_raised',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  total_native_raised: string;

  @Column({
    name: 'total_asset_value_native',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  total_asset_value_native: string;

  @Column({
    name: 'fdv_native',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  fdv_native: string;

  @Column({
    name: 'vt_price',
    type: 'decimal',
    precision: 78,
    scale: 18,
    default: 0,
  })
  vt_price: string;

  @Column({ name: 'lp_carveout', type: 'jsonb', default: () => "'{}'::jsonb" })
  lp_carveout: Record<string, unknown>;

  /** 0x-prefixed bytes32; null until snapshot reaches `ready`. */
  @Column({ name: 'merkle_root', type: 'varchar', length: 66, nullable: true })
  merkle_root?: string;

  /** 0x-prefixed bytes32 (`keccak256(canonicalJson(snapshot))`). */
  @Column({ name: 'valuation_hash', type: 'varchar', length: 66, nullable: true })
  valuation_hash?: string;

  @Column({
    name: 'total_vt_allocation',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  total_vt_allocation: string;

  @Column({
    name: 'total_native_allocation',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  total_native_allocation: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: EvmSnapshotStatus,
    enumName: 'evm_snapshot_status_enum',
    default: EvmSnapshotStatus.calculated,
  })
  status: EvmSnapshotStatus;

  @Column({ name: 'submit_tx_hash', type: 'varchar', length: 66, nullable: true })
  submit_tx_hash?: string;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmed_at?: Date;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failure_reason?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;

  @OneToMany(() => EvmContributionValuation, valuation => valuation.snapshot)
  contribution_valuations: EvmContributionValuation[];

  @OneToMany(() => EvmAllocation, allocation => allocation.snapshot)
  allocations: EvmAllocation[];
}
