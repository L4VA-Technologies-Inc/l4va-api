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

import { Asset } from './asset.entity';
import { ColumnBigintStringTransformer } from './column-bigint-string.transformer';
import { Transaction } from './transaction.entity';
import { Vault } from './vault.entity';

/**
 * Mirrors Solidity `Contribution.status` (VaultTypes.sol#L…):
 *   0 → Active
 *   1 → Cancelled  (mapped to 'refunded' in the DB for consistency with
 *                    Transaction/Asset naming)
 */
export enum EvmContributionRowStatus {
  active = 'active',
  refunded = 'refunded',
}

/**
 * One row per on-chain Vault.contribution(id). A single DB `Transaction`
 * may hold N assets and therefore produces N on-chain contributions, each
 * of which becomes one row here.
 *
 * `(vault_id, on_chain_contribution_id)` is unique — this is the key
 * webhook + admin flows use for exactly-once refund updates.
 *
 * WEBHOOK RECONCILIATION CONTRACT (EvmWebhookService, Phase E):
 *   On `ContributionMade(contributionId, cycleId, contributor, kind, asset,
 *   tokenId, amount)` the handler MUST:
 *     1. Look up the parent DB Transaction by `contribution_tx_hash`
 *        (falling back to a query on the vault id + contributor if the tx
 *        hash was renamed by a reorg-safe path).
 *     2. Verify EVERY field matches an expected asset in the parent
 *        Transaction: vault, cycle, contributor, kind, asset address,
 *        token id, amount. Mismatch → alert + skip; NEVER upsert.
 *     3. Upsert idempotently keyed on `(vault_id, on_chain_contribution_id)`.
 *   The webhook is a reconciliation path — the admin operation service
 *   creates rows first via simulate→broadcast→receipt, so a repeated
 *   webhook must be a no-op.
 */
@Entity('evm_contributions')
@Index(['vault_id', 'on_chain_contribution_id'], { unique: true })
@Index(['contributor'])
@Index(['vault_id', 'cycle_id'])
@Index(['transaction_id'])
@Index(['status'])
export class EvmContribution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Transaction, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transaction_id' })
  transaction: Transaction;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transaction_id: string;

  @ManyToOne(() => Asset, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asset_id' })
  asset_row?: Asset;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  asset_id?: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  @Column({ name: 'cycle_id', type: 'bigint' })
  cycle_id: string;

  /** Value returned by Vault.getContribution(id).id — the Solidity contribution key. */
  @Column({
    name: 'on_chain_contribution_id',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  on_chain_contribution_id: string;

  /** Hash of the contribute* transaction that created this row on-chain. */
  @Column({ name: 'contribution_tx_hash', type: 'varchar', length: 66 })
  contribution_tx_hash: string;

  @Column({ name: 'log_index', type: 'integer', nullable: true })
  log_index?: number;

  @Column({ name: 'block_number', type: 'bigint', nullable: true })
  block_number?: string;

  @Column({ name: 'contributor', type: 'varchar', length: 42 })
  contributor: string;

  /** AssetKind enum (0=Native, 1=ERC20, 2=ERC721, 3=ERC1155). Mirrors VaultTypes.sol. */
  @Column({ name: 'kind', type: 'smallint' })
  kind: number;

  /** Asset contract address (0x0 for Native). */
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

  /** Raw on-chain quantity (wei / token base units / 1 for ERC721 / unit for ERC1155). */
  @Column({
    name: 'amount',
    type: 'decimal',
    precision: 78,
    scale: 0,
    transformer: new ColumnBigintStringTransformer(),
  })
  amount: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: EvmContributionRowStatus,
    enumName: 'evm_contribution_status_enum',
    default: EvmContributionRowStatus.active,
  })
  status: EvmContributionRowStatus;

  @Column({ name: 'refund_tx_hash', type: 'varchar', length: 66, nullable: true })
  refund_tx_hash?: string;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refunded_at?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updated_at: Date;
}
