import { Expose } from 'class-transformer';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
  ValueTransformer,
} from 'typeorm';

import { AssetType, AssetStatus, AssetOriginType } from '../types/asset.types';

import { Transaction } from './transaction.entity';
import { User } from './user.entity';
import { Vault } from './vault.entity';

export class ColumnNumericTransformer {
  to(data: number): number {
    return data;
  }
  from(data: string): number {
    return parseFloat(data);
  }
}

export const imageUrlTransformer: ValueTransformer = {
  to: (value: string) => value,
  from: (value: string) => {
    if (!value) return value;

    const protocol = process.env.NODE_ENV === 'dev' ? 'http://' : 'https://';
    const host = process.env.APP_HOST || 'localhost:3000';
    const baseUrl = `${protocol}${host}/api/v1/asset-image/`;

    if (!value.includes('/') && !value.includes(':')) {
      return `${baseUrl}${value}`;
    }

    if (value.startsWith('ipfs://')) {
      const cid = value.split('/').pop();
      return `${baseUrl}${cid}`;
    }

    return value;
  },
};

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'vault_id', nullable: true })
  vault_id: string;

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

  /**
   * Raw quantity of the asset as stored in the database, not adjusted for decimals. For fungible tokens, this represents the total quantity.
   * For NFTs, this is typically 1. The actual value in human-readable form should be calculated using the 'decimals' field when applicable.
   */
  @Column({
    type: 'decimal',
    precision: 20,
    scale: 2,
    default: 0,
    transformer: new ColumnNumericTransformer(),
  })
  quantity: number;

  @Expose({ name: 'floorPrice' }) // ADA floor price from marketplaces
  @Column({
    name: 'floor_price',
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
    transformer: new ColumnNumericTransformer(),
  })
  floor_price?: number;

  @Expose({ name: 'dexPrice' }) // ADA price from DEXs
  @Column({
    name: 'dex_price',
    type: 'decimal',
    precision: 20,
    scale: 15,
    nullable: true,
    transformer: new ColumnNumericTransformer(),
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
  @Column({ name: 'image', type: 'text', nullable: true, transformer: imageUrlTransformer })
  image?: string;

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
  @ManyToOne(() => User, (addedBy: User) => addedBy.id, { nullable: true })
  @JoinColumn({ name: 'added_by' })
  public added_by: User | null;

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

  /**
   * Get normalized (human-readable) quantity
   *
   * Storage formats:
   * - FT tokens: Stored in raw units (e.g., 3,000,000 base units) → normalize by decimals
   * - ADA: Stored in ADA units (e.g., 5250.00 ADA) → already normalized
   * - NFTs: Always 1 → no normalization needed
   *
   * @returns Normalized quantity (e.g., 3.0 tokens instead of 3,000,000 raw units)
   */
  get normalizedQuantity(): number {
    // ADA is already stored in ADA units (not lovelace)
    if (this.type === AssetType.ADA) {
      return this.quantity;
    }

    // NFTs are always quantity 1
    if (this.type === AssetType.NFT) {
      return 1;
    }

    // FTs need decimal normalization
    const decimals = this.decimals || 0;
    return decimals > 0 ? this.quantity / Math.pow(10, decimals) : this.quantity;
  }

  /**
   * Get the effective price for this asset
   * Prioritizes floor_price for NFTs, dex_price for FTs
   *
   * @returns Price in ADA per normalized token
   */
  get effectivePrice(): number {
    if (this.type === AssetType.NFT) {
      return this.floor_price || this.dex_price || 0;
    }
    return this.dex_price || this.floor_price || 0;
  }

  /**
   * Get the total value of this asset in ADA
   * Uses normalized quantity and effective price
   *
   * @returns Total value in ADA
   */
  get valueAda(): number {
    return this.normalizedQuantity * this.effectivePrice;
  }
}
