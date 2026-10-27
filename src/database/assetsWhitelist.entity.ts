import { Expose, Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import {
  BeforeInsert,
  BeforeUpdate,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { ColumnBigintStringTransformer } from './column-bigint-string.transformer';
import { Vault } from './vault.entity';

@Entity({ name: 'assets_whitelist' })
@Unique(['vault', 'policy_id'])
export class AssetsWhitelistEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose({ name: 'policyId' })
  @Column({ type: 'varchar', length: 56, nullable: false })
  @Matches(/^(?:[0-9a-fA-F]{56}|0x[0-9a-fA-F]{40})$/, {
    message: 'Asset identifier must be a Cardano policy ID (56 hex chars) or EVM contract address (0x + 40 hex chars)',
  })
  policy_id: string;

  @Expose({ name: 'collectionName' })
  @Column({ type: 'varchar', length: 255, nullable: true })
  collection_name?: string;

  @Expose({ name: 'countCapMin' })
  @Transform(({ value }) => (value !== null && value !== undefined ? Number(value) : null))
  @Column({
    name: 'asset_count_cap_min',
    type: 'bigint',
    nullable: true,
  })
  asset_count_cap_min?: number;

  @Expose({ name: 'countCapMax' })
  @Transform(({ value }) => (value !== null && value !== undefined ? Number(value) : null))
  @Column({
    name: 'asset_count_cap_max',
    type: 'bigint',
    nullable: true,
  })
  asset_count_cap_max?: number;

  @Expose({ name: 'valuationMethod' })
  @Column({
    name: 'valuation_method',
    type: 'varchar',
    length: 20,
    nullable: true,
    default: 'market',
  })
  valuation_method?: string;

  @Expose({ name: 'customPriceAda' })
  @Column({
    name: 'custom_price_ada',
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
  })
  custom_price_ada?: number;

  /**
   * EVM: per-collection manual/floor price in wei per whole unit.
   * ERC-20 → wei per whole token (10^decimals base units).
   * ERC-721 / ERC-1155 → wei per NFT.
   * When set, this overrides Chainlink lookups for this vault.
   * Stored as bigint via ColumnBigintStringTransformer — never JS number.
   */
  @Expose({ name: 'customPriceNativeWei' })
  @Column({
    name: 'custom_price_native_wei',
    type: 'decimal',
    precision: 78,
    scale: 0,
    nullable: true,
    transformer: new ColumnBigintStringTransformer(),
  })
  custom_price_native_wei?: string;

  @Expose({ name: 'lpPoolOnchainId' })
  @Column({ name: 'lp_pool_onchain_id', nullable: true, type: 'text' })
  lp_pool_onchain_id: string | null;

  @ManyToOne(() => Vault, (vault: Vault) => vault.assets_whitelist, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  public vault: Vault;

  @Expose({ name: 'updatedAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: Date;

  @Expose({ name: 'createdAt' })
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @BeforeInsert()
  setDate(): void {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  @BeforeUpdate()
  updateDate(): void {
    this.updated_at = new Date();
  }
}
