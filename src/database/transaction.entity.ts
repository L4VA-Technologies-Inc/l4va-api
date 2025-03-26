import {Column, Entity, PrimaryGeneratedColumn} from "typeorm";
import {ApiProperty} from "@nestjs/swagger";
import {Expose} from "class-transformer";
import {TransactionStatus, TransactionType} from "../types/transaction.types";


@Entity('transactions')
export class User {

  @ApiProperty({ description: 'Unique identifier of the transaction' })
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id: string;

  @Expose({ name: 'sender' })
  @Column()
  sender: string;

  @Expose({ name: 'receiver' })
  @Column()
  receiver: string;

  @Expose({ name: 'type'})
  @Column({
    name: 'type',
    type: 'enum',
    enum: TransactionType,
    nullable: true
  })
  type?: TransactionType;

  @Expose({ name: 'fee' })
  @Column()
  fee: number;

  @Expose({ name: 'txHash' })
  @Column()
  txHash: string;

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
  @Column()
  metadata: any;

}
