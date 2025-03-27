import {Column, Entity, PrimaryGeneratedColumn} from "typeorm";
import {ApiProperty} from "@nestjs/swagger";
import {Expose} from "class-transformer";
import {TransactionStatus, TransactionType} from "../types/transaction.types";


@Entity('transactions')
export class Transaction {

  @ApiProperty({ description: 'Unique identifier of the transaction' })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'sender' })
  @Column()
  sender: string;

  @Expose({ name: 'receiver' })
  @Column()
  receiver: string;

  @Column({
    name: 'type',
    type: 'enum',
    enum: TransactionType,
    nullable: true
  })
  type?: TransactionType;

  @Column()
  fee: number;

  @Expose({ name: 'txHash' })
  @Column()
  tx_hash: string;

  @Expose({ name: 'block' })
  @Column()
  block: number;

  @Expose({ name: 'status'})
  @Column({
    name: 'status',
    type: 'enum',
    enum: TransactionStatus,
    nullable: true
  })
  status?: TransactionStatus;

  @Expose({ name: 'metadata' })
  @Column({
    name: 'metadata',
    type: 'jsonb',
    nullable: true
  })
  metadata: any;

}
