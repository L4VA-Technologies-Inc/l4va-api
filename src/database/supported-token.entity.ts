import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One token of the public /supported-tokens list: a token index vaults can trade today.
 * Written by `swap-pool-review.ts` through the admin endpoint (the whole list of a chain is
 * replaced at once); read by the public endpoint, which hides a token as soon as one of its
 * `pool_ids` is no longer allowlisted on the swap adapter.
 */
@Entity('supported_tokens')
export class SupportedTokenRow {
  @PrimaryColumn({ name: 'chain_id', type: 'int' })
  chainId: number;

  /** Lower-case token address. */
  @PrimaryColumn({ type: 'varchar', length: 42 })
  address: string;

  @Column({ type: 'varchar', length: 64 })
  symbol: string;

  @Column({ type: 'varchar', length: 256 })
  name: string;

  /** Trust category from swap-token-report.ts. */
  @Column({ type: 'varchar', length: 64 })
  category: string;

  /** good: round trip within the approve limit at ref_eth; thin: small vaults only. */
  @Column({ type: 'varchar', length: 8 })
  liquidity: 'good' | 'thin';

  @Column({ name: 'round_trip_loss_bps', type: 'int', nullable: true })
  roundTripLossBps: number | null;

  /** Size of the round trip, in ETH (e.g. "0.1"). */
  @Column({ name: 'ref_eth', type: 'varchar', length: 16 })
  refEth: string;

  /** Guarded-adapter pool ids the token trades through; all must stay allowlisted. */
  @Column({ name: 'pool_ids', type: 'text', array: true, default: () => "'{}'" })
  poolIds: string[];

  @Column({ name: 'checked_at', type: 'timestamptz' })
  checkedAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
