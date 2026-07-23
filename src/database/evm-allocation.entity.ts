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

import { ColumnBigintStringTransformer } from './column-bigint-string.transformer';
import { EvmValuationSnapshot } from './evm-valuation-snapshot.entity';
import { Vault } from './vault.entity';

/**
 * One Merkle leaf per (vault_id, cycle_id, claim_index).
 * The tuple is UNIQUE and mirrors exactly what the on-chain contract expects:
 *
 *   leaf = keccak256(abi.encode(vault, chainId, cycleId, claimIndex, contributor, vtAmount, nativeAmount))
 *
 * Amounts are stored in the smallest units expected by the contract:
 *   vt_amount     — VT base units (respects vt token decimals)
 *   native_amount — wei
 */
@Entity('evm_allocations')
@Index(['vault_id', 'cycle_id', 'claim_index'], { unique: true })
@Index(['contributor'])
export class EvmAllocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EvmValuationSnapshot, snapshot => snapshot.allocations, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot: EvmValuationSnapshot;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshot_id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  @Column({ name: 'cycle_id', type: 'bigint' })
  cycle_id: string;

  /** Unique index within the cycle — used as leaf ordering + on-chain dedup key. */
  @Column({ name: 'claim_index', type: 'bigint' })
  claim_index: string;

  /** Recipient address baked into the leaf; the contract routes funds here regardless of caller. */
  @Column({ name: 'contributor', type: 'varchar', length: 42 })
  contributor: string;

  @Column({
    name: 'vt_amount',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  vt_amount: string;

  @Column({
    name: 'native_amount',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  native_amount: string;

  /** Ordered sibling hashes; passed as `bytes32[]` to `claimAllocation(s)`. */
  @Column({ name: 'proof', type: 'jsonb' })
  proof: string[];

  /** Set by the AllocationClaimed webhook / airdrop confirm — idempotent. */
  @Column({ name: 'claimed_at', type: 'timestamptz', nullable: true })
  claimed_at?: Date;

  @Column({ name: 'claim_tx_hash', type: 'varchar', length: 66, nullable: true })
  claim_tx_hash?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
