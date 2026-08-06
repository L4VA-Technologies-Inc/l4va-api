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
import { Transaction } from './transaction.entity';
import { Vault } from './vault.entity';

export enum EvmPositionStatus {
  active = 'active',
  closed = 'closed',
  failed = 'failed',
}

/**
 * Mirrors on-chain ExternalPosition (VaultTypes.sol).
 * One row per Vault.openPosition() call. Closed by Vault.closePosition().
 *
 * `(vault_id, on_chain_position_id)` is unique — reconciler uses it for
 * exactly-once PositionOpened / PositionClosed webhook processing.
 */
@Entity('evm_external_positions')
@Index(['vault_id', 'on_chain_position_id'], { unique: true })
@Index(['vault_id', 'status'])
@Index(['adapter'])
export class EvmExternalPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  /** Admin Transaction that broadcast openPosition. */
  @ManyToOne(() => Transaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'open_tx_id' })
  open_tx?: Transaction;

  @Column({ name: 'open_tx_id', type: 'uuid', nullable: true })
  open_tx_id?: string;

  /** Admin Transaction that broadcast closePosition. */
  @ManyToOne(() => Transaction, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'close_tx_id' })
  close_tx?: Transaction;

  @Column({ name: 'close_tx_id', type: 'uuid', nullable: true })
  close_tx_id?: string;

  /** On-chain positionId from PositionOpened event. */
  @Column({ name: 'on_chain_position_id', type: 'varchar' })
  on_chain_position_id: string;

  /** Adapter contract address. */
  @Column({ name: 'adapter', type: 'varchar' })
  adapter: string;

  /** Protocol tag supplied in OpenPositionParams.protocol (informational). */
  @Column({ name: 'protocol', type: 'varchar', nullable: true })
  protocol?: string;

  /** address(0) for native ETH input, ERC-20 address otherwise. */
  @Column({ name: 'underlying_asset', type: 'varchar' })
  underlying_asset: string;

  @Column({
    name: 'amount_deposited',
    type: 'numeric',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  amount_deposited: string;

  /** ERC-20 position token received by vault. */
  @Column({ name: 'position_asset', type: 'varchar' })
  position_asset: string;

  @Column({
    name: 'position_amount',
    type: 'numeric',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  position_amount: string;

  @Column({ name: 'status', type: 'enum', enum: EvmPositionStatus, default: EvmPositionStatus.active })
  status: EvmPositionStatus;

  /** Raw on-chain operationId bytes32 (hex). */
  @Column({ name: 'operation_id', type: 'varchar', nullable: true })
  operation_id?: string;

  /** Amount of underlying_asset returned when position was closed. */
  @Column({
    name: 'underlying_returned',
    type: 'numeric',
    precision: 78,
    scale: 0,
    nullable: true,
    transformer: new ColumnBigintStringTransformer(),
  })
  underlying_returned?: string;

  @Column({ name: 'open_tx_hash', type: 'varchar', nullable: true })
  open_tx_hash?: string;

  @Column({ name: 'close_tx_hash', type: 'varchar', nullable: true })
  close_tx_hash?: string;

  @Column({ name: 'open_block_number', type: 'varchar', nullable: true })
  open_block_number?: string;

  @Column({ name: 'close_block_number', type: 'varchar', nullable: true })
  close_block_number?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
