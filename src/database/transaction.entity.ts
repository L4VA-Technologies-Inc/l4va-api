import {Column, Entity, OneToMany, PrimaryGeneratedColumn} from 'typeorm';
import {ApiProperty} from '@nestjs/swagger';
import {Exclude, Expose} from 'class-transformer';
import {TransactionStatus, TransactionType} from '../types/transaction.types';
import {Asset} from './asset.entity';


@Entity('transactions')
export class Transaction {

  @ApiProperty({ description: 'Unique identifier of the transaction' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'utxoInput' })
  @Column({
    nullable: true
  })
  utxo_input: string; // sender

  @Expose({ name: 'utxoOutput' })
  @Column({
    nullable: true
  })
  utxo_output: string; // receiver

  @Expose({ name: 'utxoRef' })
  @Column({
    nullable: true
  })
  utxo_ref: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: TransactionType,
    nullable: true
  })
  type?: TransactionType;

  @Column({
    nullable: true
  })
  amount: number;

  @Column({
    nullable: true
  })
  fee: number;

  @Expose({ name: 'txHash' })
  @Column({
   nullable: true
  })
  tx_hash: string; // 1

  @Expose({ name: 'status'})
  @Column({
    name: 'status',
    type: 'enum',
    enum: TransactionStatus,
    nullable: true
  })
  status?: TransactionStatus; //

  @Exclude()
  @OneToMany(() => Asset, (asset: Asset) => asset.transaction )
  public assets: Asset [];

}
