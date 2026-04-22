import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Transaction } from './transaction.entity';
import { User } from './user.entity';

export enum TokenType {
  L4VA = 'L4VA',
  VLRM = 'VLRM',
}

export enum StakingStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

@Entity('token_staking_positions', { schema: 'public' })
export class TokenStakingPosition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id', type: 'uuid' })
  @Index()
  user_id: string;

  @Column({
    name: 'token_type',
    type: 'enum',
    enum: TokenType,
  })
  token_type: TokenType;

  @Column({
    name: 'amount',
    type: 'bigint',
    default: 0,
    comment: 'Smallest on-chain units (raw token amount locked in this box).',
  })
  amount: number;

  @Column({
    name: 'status',
    type: 'enum',
    enum: StakingStatus,
    default: StakingStatus.ACTIVE,
  })
  status: StakingStatus;

  @ManyToOne(() => Transaction, { nullable: true, eager: false })
  @JoinColumn({ name: 'stake_tx_id' })
  stake_transaction: Transaction;

  @Column({
    name: 'stake_tx_id',
    type: 'uuid',
    nullable: true,
    comment: 'Transaction that created (or re-created after harvest/compound) this staking box.',
  })
  @Index()
  stake_tx_id: string | null;

  @ManyToOne(() => Transaction, { nullable: true })
  @JoinColumn({ name: 'unstake_tx_id' })
  unstake_transaction: Transaction;

  @Column({
    name: 'unstake_tx_id',
    type: 'uuid',
    nullable: true,
    comment: 'Transaction that closed this staking position.',
  })
  @Index()
  unstake_tx_id: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
