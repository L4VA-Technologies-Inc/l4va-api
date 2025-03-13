import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
  Index
} from 'typeorm';
import { Vault } from './vault.entity';
import { AssetType, AssetStatus } from '../types/asset.types';
import { Expose } from 'class-transformer';

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Expose({ name: 'vaultId' })
  @Column({ name: 'vault_id' })
  vault_id: string;

  @ManyToOne(() => Vault, vault => vault.assets)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({
    type: 'enum',
    enum: AssetType
  })
  type: AssetType;

  @Expose({ name: 'contractAddress' })
  @Column({ name: 'contract_address' })
  contract_address: string;

  @Expose({ name: 'tokenId' })
  @Column({ name: 'token_id', nullable: true })
  token_id?: string;

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
  metadata: {
    name: string;
    description: string;
    imageUrl: string;
    category?: string;
    attributes: Record<string, any>;
  };

  @Expose({ name: 'addedBy' })
  @Column({ name: 'added_by' })
  added_by: string;

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
