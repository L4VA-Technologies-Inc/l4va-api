import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { TransactionStatus, TransactionType } from '../types/transaction.types';

import { Asset } from './asset.entity';
import { User } from './user.entity';
import { Vault } from './vault.entity';

@Entity('transactions')
export class Transaction {
  @ApiProperty({ description: 'Unique identifier of the transaction' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'utxoInput' })
  @Column({ nullable: true })
  utxo_input: string; // sender

  @Expose({ name: 'utxoOutput' })
  @Column({ nullable: true })
  utxo_output: string; // receiver

  @Expose({ name: 'txIndex' })
  @Column({ nullable: true })
  tx_index: string;

  @Expose({ name: 'utxoRef' })
  @Column({ nullable: true })
  utxo_ref: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: TransactionType,
    nullable: true,
  })
  type?: TransactionType;

  @Column({ nullable: true })
  amount: number;

  @ApiProperty({ description: 'Transaction fee in lovelace' })
  @Column({ nullable: true })
  fee: number;

  @Expose({ name: 'txHash' })
  @Column({ nullable: true })
  tx_hash: string; // 1

  @Expose({ name: 'status' })
  @Column({
    name: 'status',
    type: 'enum',
    enum: TransactionStatus,
    nullable: true,
  })
  status?: TransactionStatus; //

  @Column({
    type: 'jsonb',
    nullable: true,
  })
  metadata?: Record<string, any>;

  @ApiProperty({ description: 'Whether this transaction occurred during an expansion phase' })
  @Column({ name: 'is_expansion', type: 'boolean', default: false, nullable: false })
  is_expansion: boolean;

  @ApiProperty({ description: 'Proposal ID related to this expansion transaction' })
  @Column({ name: 'expansion_proposal_id', nullable: true, type: 'uuid' })
  expansion_proposal_id?: string;

  @Exclude()
  @OneToMany(() => Asset, (asset: Asset) => asset.transaction)
  public assets: Asset[];

  @Expose({ name: 'user' })
  @ManyToOne(() => User, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', nullable: true, type: 'uuid' })
  @Index()
  user_id: string;

  @ManyToOne(() => Vault)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', nullable: true })
  @Index()
  vault_id: string;

  @Expose({ name: 'updatedAt' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @Expose({ name: 'createdAt' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  // ---------------------------------------------------------------------------
  // EVM-specific fields — null for Cardano rows.
  // Cardano uses utxo_input / utxo_output / utxo_ref for the same concepts.
  // ---------------------------------------------------------------------------

  /** EVM: wallet or contract that originated the transaction (msg.sender). */
  @Expose({ name: 'fromAddress' })
  @Column({ name: 'from_address', nullable: true })
  from_address?: string;

  /** EVM: target contract or recipient address. */
  @Expose({ name: 'toAddress' })
  @Column({ name: 'to_address', nullable: true })
  to_address?: string;

  /** EVM: block number in which the transaction was included. */
  @Expose({ name: 'blockNumber' })
  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  block_number?: number;

  /**
   * Numeric EVM chain ID (e.g. 46630 for Robinhood testnet).
   * Allows chain discrimination without joining through the vault.
   */
  @Expose({ name: 'chainId' })
  @Column({ name: 'chain_id', type: 'bigint', nullable: true })
  chain_id?: number;

  /**
   * Index of the event log within the block.
   * Used when a transaction emits multiple relevant events
   * (e.g. VaultCreated + Transfer) and each needs a distinct record.
   */
  @Expose({ name: 'logIndex' })
  @Column({ name: 'log_index', type: 'integer', nullable: true })
  log_index?: number;
}
