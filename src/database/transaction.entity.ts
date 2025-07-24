import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, Index } from 'typeorm';

import { TransactionStatus, TransactionType } from '../types/transaction.types';

import { Asset } from './asset.entity';
import { Vault } from './vault.entity';

@Entity('transactions')
export class Transaction {
  @ApiProperty({ description: 'Unique identifier of the transaction' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'utxoInput' })
  @Column({
    nullable: true,
  })
  utxo_input: string; // sender

  @Expose({ name: 'utxoOutput' })
  @Column({
    nullable: true,
  })
  utxo_output: string; // receiver

  @Expose({ name: 'utxoRef' })
  @Column({
    nullable: true,
  })
  utxo_ref: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: TransactionType,
    nullable: true,
  })
  type?: TransactionType;

  @Column({
    nullable: true,
  })
  amount: number;

  @Column({
    nullable: true,
  })
  fee: number;

  @Expose({ name: 'txHash' })
  @Column({
    nullable: true,
  })
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

  @Exclude()
  @OneToMany(() => Asset, (asset: Asset) => asset.transaction)
  public assets: Asset[];

  @ManyToOne(() => Vault)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', nullable: true })
  @Index()
  vault_id: string;

  @Column({ name: 'user_id', nullable: true })
  @Index()
  user_id: string;
}
