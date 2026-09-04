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

import { MarketTokenKind, MarketType } from '../types/market.types';

import { Vault } from './vault.entity';

@Entity('markets')
export class Market {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Vault, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault | null;

  @Index('UQ_markets_vault_id', { unique: true, where: '"vault_id" IS NOT NULL' })
  @Column({ type: 'uuid', nullable: true })
  vault_id: string | null;

  @Index('IDX_markets_type')
  @Column({
    type: 'enum',
    enum: MarketType,
    default: MarketType.vault_token,
  })
  type: MarketType;

  @Column({
    type: 'enum',
    enum: MarketTokenKind,
    nullable: true,
  })
  token_kind: MarketTokenKind | null;

  @Column({ type: 'varchar', nullable: true })
  name: string | null;

  @Column({ type: 'varchar', nullable: true })
  symbol: string | null;

  @Column({ type: 'varchar', nullable: true })
  image_url: string | null;

  @Index('UQ_markets_contract_address', { unique: true, where: '"contract_address" IS NOT NULL' })
  @Column({ type: 'varchar', nullable: true })
  contract_address: string | null;

  @Column({ type: 'varchar', nullable: true })
  pair_address: string | null;

  @Column({ type: 'varchar', nullable: true })
  policy_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  asset_name: string | null;

  @Column({ type: 'smallint', nullable: true })
  decimals: number | null;

  @Column({ type: 'integer', nullable: true })
  holders_count: number | null;

  @Column({ type: 'varchar', nullable: true })
  dex_id: string | null;

  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  price_usd: number | null;

  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  fdv: number | null;

  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  volume_24h: number | null;

  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  liquidity_usd: number | null;

  @Column({ type: 'decimal', precision: 12, scale: 4, nullable: true })
  score: number | null;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'circSupply' })
  circSupply: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  mcap: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0, name: 'totalSupply' })
  totalSupply: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: 'price_change_1h' })
  price_change_1h: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: 'price_change_24h' })
  price_change_24h: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: 'price_change_7d' })
  price_change_7d: number;

  @Column({ type: 'decimal', precision: 10, scale: 6, default: 0, name: 'price_change_30d' })
  price_change_30d: number;

  @Column({ type: 'decimal', precision: 12, scale: 4, nullable: true })
  delta: number | null; // Mkt Cap / TVL (%)

  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true, name: 'totalAdaLiquidity' })
  totalAdaLiquidity: number | null; // Total ADA liquidity across all DEX pools

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 8,
    nullable: true,
    name: 'fdv_per_asset',
  })
  fdv_per_asset: number | null; // FDV / assets count. Only for NFT-only vaults; null for FT vaults

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
