import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { Vault } from './vault.entity';
import { AssetType, AssetStatus } from '../types/asset.types';
import { Expose } from 'class-transformer';
import {Transaction} from './transaction.entity';
import {User} from "./user.entity";

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, vault => vault.assets)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault; // nullable empty if joined to transaction

  @Expose({ name: 'policyId' })
  @Column({
    name: 'policy_id'
  })
  policy_id: string;

  @Expose({ name: 'assetId' })
  @Column({
    name: 'asset_id'
  })
  asset_id: string;

  @Column({
    type: 'enum',
    enum: AssetType
  })
  type: AssetType;

  @Expose({ name: 'contractAddress' })
  @Column({ name: 'contract_address', nullable: true })
  contract_address: string;

  @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
  quantity: number;

  @Expose({ name: 'floorPrice' })
  @Column({
    name: 'floor_price',
    type: 'decimal',
    precision: 20,
    scale: 2,
    nullable: true
  })
  floor_price?: number;

  @Expose({ name: 'dexPrice' })
  @Column({
    name: 'dex_price',
    type: 'decimal',
    precision: 20,
    scale: 2,
    nullable: true
  })
  dex_price?: number;

  @Expose({ name: 'lastValuation' })
  @Column({
    name: 'last_valuation',
    type: 'timestamptz',
    nullable: true
  })
  last_valuation?: Date;

  @Column({
    type: 'enum',
    enum: AssetStatus,
    default: AssetStatus.PENDING
  })
  status: AssetStatus;

  @Expose({ name: 'lockedAt' })
  @Column({
    name: 'locked_at',
    type: 'timestamptz',
    nullable: true
  })
  locked_at?: Date;

  @Expose({ name: 'releasedAt' })
  @Column({
    name: 'released_at',
    type: 'timestamptz',
    nullable: true
  })
  released_at?: Date;

  @Column({ type: 'jsonb' })
  metadata: any;


  @Expose({ name: 'transaction' })
  @ManyToOne(() => Transaction, (transaction: Transaction) => transaction.id)
  @JoinColumn({ name: 'transaction_id' })
  public transaction: Transaction;

  @Expose({ name: 'addedBy' })
  @ManyToOne(() => User, (addedBy: User) => addedBy.id)
  @JoinColumn({ name: 'added_by' })
  public added_by: User; // added user owner

  @Expose({ name: 'addedAt' })
  @Column({
    name: 'added_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP'
  })
  added_at: Date;

  @Expose({ name: 'updatedAt' })
  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP'
  })
  updated_at: Date;

  @BeforeInsert()
  setAddedAt() {
    this.added_at = new Date();
    this.updated_at = new Date();
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updated_at = new Date();
  }
}
