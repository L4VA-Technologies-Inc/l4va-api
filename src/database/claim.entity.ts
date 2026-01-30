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

import type { ClaimMetadata } from '../types/claim-metadata.types';
import { ClaimStatus, ClaimType } from '../types/claim.types';

import { Proposal } from './proposal.entity';
import { Transaction } from './transaction.entity';
import { User } from './user.entity';
import { Vault } from './vault.entity';

@Entity('claims')
export class Claim {
  @Expose({ name: 'id' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, (user: User) => user.claims, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', nullable: true })
  @Index()
  user_id: string;

  @Expose({ name: 'vaultId' })
  @ManyToOne(() => Vault, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Expose({ name: 'type' })
  @Column({
    type: 'enum',
    enum: ClaimType,
    nullable: false,
  })
  type: ClaimType;

  @Expose({ name: 'status' })
  @Column({
    type: 'enum',
    enum: ClaimStatus,
    nullable: false,
    default: ClaimStatus.AVAILABLE,
  })
  status: ClaimStatus;

  @Expose({ name: 'amount' })
  @Column({ type: 'bigint', default: 0 })
  amount: number;

  @Expose({ name: 'lovelaceAmount' })
  @Column({ name: 'lovelace_amount', type: 'bigint', nullable: true })
  lovelace_amount?: number;

  @Expose({ name: 'multiplier' })
  @Column({ type: 'numeric', nullable: true })
  multiplier?: number;

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Column({
    name: 'transaction_id',
    nullable: true,
    comment: 'Reference to the original contribution/acquisition transaction (used to build UTxO reference)',
  })
  @Index()
  transaction_id: string;

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: 'distribution_tx_id' })
  distribution_transaction: Transaction;

  @Column({
    name: 'distribution_tx_id',
    nullable: true,
    comment: 'Reference to the transaction that paid out this claim',
  })
  @Index()
  distribution_tx_id: string;

  @ManyToOne(() => Proposal, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'proposal_id' })
  proposal: Proposal;

  @Column({
    name: 'proposal_id',
    nullable: true,
    comment: 'Reference to the proposal that created this claim (for distribution/termination)',
  })
  @Index()
  proposal_id: string;

  @Expose({ name: 'utxoToClaim' })
  get utxoToClaim(): string | null {
    if (this.transaction?.tx_hash && this.transaction?.tx_index) {
      return `${this.transaction.tx_hash}#${this.transaction.tx_index}`;
    }
    return null;
  }

  @Expose({ name: 'description' })
  @Column({ type: 'text', nullable: true })
  description: string;

  @Expose({ name: 'metadata' })
  @Column({ type: 'jsonb', nullable: true })
  metadata: ClaimMetadata;

  @Expose({ name: 'createdAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @Expose({ name: 'updatedAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
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
