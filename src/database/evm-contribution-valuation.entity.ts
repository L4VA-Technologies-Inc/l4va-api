import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { ColumnBigintStringTransformer } from './column-bigint-string.transformer';
import { EvmContribution } from './evm-contribution.entity';
import { EvmValuationSnapshot } from './evm-valuation-snapshot.entity';

/**
 * Per-contribution valuation row inside a snapshot. Captures the exact
 * pricing inputs that fed the final wallet aggregation, so the Merkle root
 * is fully reproducible from persisted data.
 *
 * FKs to `evm_contributions` (canonical per-Solidity-contribution row).
 * `on_chain_contribution_id` is kept as a denormalized copy for fast joins.
 */
@Entity('evm_contribution_valuations')
@Index(['snapshot_id'])
@Index(['contributor'])
export class EvmContributionValuation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => EvmValuationSnapshot, snapshot => snapshot.contribution_valuations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot: EvmValuationSnapshot;

  @Column({ name: 'snapshot_id', type: 'uuid' })
  snapshot_id: string;

  @ManyToOne(() => EvmContribution, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'evm_contribution_id' })
  evm_contribution: EvmContribution;

  @Column({ name: 'evm_contribution_id', type: 'uuid' })
  evm_contribution_id: string;

  /** Denormalized on-chain contribution id (matches EvmContribution.on_chain_contribution_id). */
  @Column({
    name: 'on_chain_contribution_id',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  on_chain_contribution_id: string;

  @Column({ name: 'contributor', type: 'varchar', length: 42 })
  contributor: string;

  /** AssetKind enum (0=Native, 1=ERC20, 2=ERC721, 3=ERC1155). */
  @Column({ name: 'kind', type: 'smallint' })
  kind: number;

  @Column({ name: 'asset', type: 'varchar', length: 42 })
  asset: string;

  @Column({
    name: 'token_id',
    type: 'decimal',
    precision: 78,
    scale: 0,
    default: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  token_id: string;

  /** Raw on-chain quantity (wei for native, base units for ERC20, 1 for ERC721, unit for ERC1155). */
  @Column({
    name: 'amount_raw',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  amount_raw: string;

  /**
   * Amount in whole-unit base: for ERC20 = amount_raw scaled by 10^18 / 10^decimals
   * (i.e. 18-decimal-normalized quantity in wei-scale); for NFTs = count * 10^18;
   * for Native = wei directly. Stored as bigint via ColumnBigintStringTransformer.
   */
  @Column({
    name: 'amount_normalized',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  amount_normalized: string;

  /**
   * Unit price in wei per whole unit.
   *   ERC-20 → wei per whole token (10^decimals base units)
   *   ERC-721 / ERC-1155 → wei per NFT
   *   Native → 1
   * Stored as bigint via ColumnBigintStringTransformer.
   */
  @Column({
    name: 'unit_price_native',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  unit_price_native: string;

  /** Total native value in wei (amount_normalized * unit_price_native, rounded). */
  @Column({
    name: 'value_native',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  value_native: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;
}
