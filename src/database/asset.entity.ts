import { Expose } from 'class-transformer';
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert, BeforeUpdate } from 'typeorm';

import { AssetType, AssetStatus, AssetOriginType } from '../types/asset.types';

import { Transaction } from './transaction.entity';
import { User } from './user.entity';
import { Vault } from './vault.entity';

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, vault => vault.assets)
  @JoinColumn({ name: 'vault_id' })
  vault: Vault; // nullable empty if joined to transaction

  @Expose({ name: 'policyId' })
  @Column({
    name: 'policy_id',
  })
  policy_id: string;

  @Expose({ name: 'assetId' }) // Asset name in hex
  @Column({
    name: 'asset_id',
  })
  asset_id: string;

  @Column({
    type: 'enum',
    enum: AssetType,
  })
  type: AssetType;

  @Column({ type: 'decimal', precision: 20, scale: 2, default: 0 })
  quantity: number;

  @Expose({ name: 'floorPrice' }) // ADA floor price from marketplaces
  @Column({
    name: 'floor_price',
    type: 'decimal',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  floor_price?: number;

  @Expose({ name: 'dexPrice' }) // ADA price from DEXs
  @Column({
    name: 'dex_price',
    type: 'decimal',
    precision: 20,
    scale: 2,
    nullable: true,
  })
  dex_price?: number;

  @Column({ name: 'deleted', type: 'boolean', nullable: false, default: false })
  deleted: boolean;

  @Expose({ name: 'lastValuation' })
  @Column({
    name: 'last_valuation',
    type: 'timestamptz',
    nullable: true,
  })
  last_valuation?: Date;

  @Column({
    type: 'enum',
    enum: AssetStatus,
    default: AssetStatus.PENDING,
  })
  status: AssetStatus;

  @Expose({ name: 'lockedAt' })
  @Column({
    name: 'locked_at',
    type: 'timestamptz',
    nullable: true,
  })
  locked_at?: Date;

  @Expose({ name: 'releasedAt' })
  @Column({
    name: 'released_at',
    type: 'timestamptz',
    nullable: true,
  })
  released_at?: Date;

  @Expose({ name: 'originType' })
  @Column({
    name: 'origin_type',
    type: 'enum',
    enum: AssetOriginType,
    nullable: true,
    comment: 'Source or origin type of the asset (INVESTED, CONTRIBUTED)',
  })
  origin_type?: AssetOriginType;

  @Expose({ name: 'image' })
  @Column({ name: 'image', type: 'text', nullable: true })
  image?: string; // stores ipfs://...

  @Expose({ name: 'imageUrl' })
  get imageUrl(): string | null {
    if (!this.image) return null;
    if (this.image.startsWith('ipfs://')) {
      return this.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }
    return this.image; // already HTTP or other protocol
  }

  @Expose({ name: 'decimals' })
  @Column({ name: 'decimals', type: 'int', nullable: true })
  decimals?: number;

  @Expose({ name: 'name' })
  @Column({ name: 'name', type: 'text', nullable: true })
  name?: string;

  @Expose({ name: 'description' })
  @Column({ name: 'description', type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  @Expose({ name: 'metadata' })
  metadata: any;

  @Expose({ name: 'listingMarket' })
  @Column({ name: 'listing_market', type: 'text', nullable: true })
  listing_market?: string;

  @Expose({ name: 'listingPrice' })
  @Column({ name: 'listing_price', type: 'decimal', precision: 20, scale: 6, nullable: true })
  listing_price?: number;

  @Expose({ name: 'listingTxHash' })
  @Column({ name: 'listing_tx_hash', type: 'text', nullable: true })
  listing_tx_hash?: string;

  @Expose({ name: 'listedAt' })
  @Column({ name: 'listed_at', type: 'timestamptz', nullable: true })
  listed_at?: Date;

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
    default: () => 'CURRENT_TIMESTAMP',
  })
  added_at: Date;

  @Expose({ name: 'updatedAt' })
  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updated_at: Date;

  @BeforeInsert()
  setAddedAt(): void {
    this.added_at = new Date();
    this.updated_at = new Date();
  }

  @BeforeUpdate()
  updateTimestamp(): void {
    this.updated_at = new Date();
  }
}
