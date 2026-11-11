import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Vault } from './vault.entity';

/**
 * One competition season. Rows are inserted by hand (SQL) for v0.1; the
 * season whose window contains "now" (or the latest one) is "current".
 */
@Entity('competition_seasons')
export class CompetitionSeason {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', unique: true })
  slug: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ name: 'start_at', type: 'timestamptz' })
  start_at: Date;

  /** Vaults launched after this are not entered. */
  @Column({ name: 'entry_cutoff_at', type: 'timestamptz' })
  entry_cutoff_at: Date;

  @Column({ name: 'promo_end_at', type: 'timestamptz', nullable: true })
  promo_end_at: Date | null;

  @Column({ name: 'end_at', type: 'timestamptz' })
  end_at: Date;

  /** Pool liquidity (USD) an entry needs to count as Qualified. */
  @Column({ name: 'min_liquidity_usd', type: 'numeric', default: 0 })
  min_liquidity_usd: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  created_at: Date;
}

export enum CompetitionEntryStatus {
  active = 'active',
  review = 'review',
  disqualified = 'disqualified',
}

@Entity('competition_entries')
@Index(['season_id', 'vault_id'], { unique: true })
export class CompetitionEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => CompetitionSeason, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'season_id' })
  season: CompetitionSeason;

  @Column({ name: 'season_id', type: 'uuid' })
  season_id: string;

  @ManyToOne(() => Vault, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vault_id' })
  vault: Vault;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  /** First snapshot with a live pool price; returns are measured from here. */
  @Column({ name: 'entered_at', type: 'timestamptz' })
  entered_at: Date;

  @Column({ name: 'entry_price_usd', type: 'numeric' })
  entry_price_usd: string;

  @Column({ name: 'entry_value_usd', type: 'numeric', default: 0 })
  entry_value_usd: string;

  /** Manual moderation: set to `review` / `disqualified` via SQL. */
  @Column({ type: 'varchar', default: CompetitionEntryStatus.active })
  status: CompetitionEntryStatus;
}

@Entity('competition_snapshots')
@Index(['season_id', 'vault_id', 'taken_at'])
export class CompetitionSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'season_id', type: 'uuid' })
  season_id: string;

  @Column({ name: 'vault_id', type: 'uuid' })
  vault_id: string;

  @Column({ name: 'taken_at', type: 'timestamptz' })
  taken_at: Date;

  @Column({ name: 'price_usd', type: 'numeric' })
  price_usd: string;

  /** Vault asset value (NAV). */
  @Column({ name: 'value_usd', type: 'numeric', default: 0 })
  value_usd: string;

  @Column({ name: 'fdv_usd', type: 'numeric', default: 0 })
  fdv_usd: string;

  @Column({ name: 'liquidity_usd', type: 'numeric', default: 0 })
  liquidity_usd: string;

  @Column({ type: 'integer', nullable: true })
  holders: number | null;
}
