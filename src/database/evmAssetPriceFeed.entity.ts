import { BeforeInsert, BeforeUpdate, Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Global registry of EVM token → Chainlink price feed mappings.
 * One row per (chain_id, token_address) pair, shared across all vaults.
 *
 * Lookup order in getEvmPriceAda:
 *   1. assets_whitelist.custom_price_ada  (vault-specific override)
 *   2. evm_asset_price_feeds.chainlink_feed_address  (on-chain Chainlink)
 *   3. DexScreener  (when allow_dexscreener_fallback = true)
 *   4. null / 0
 */
@Entity({ name: 'evm_asset_price_feeds' })
@Unique(['chain_id', 'token_address'])
export class EvmAssetPriceFeedEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** EVM chain ID (e.g. 46630 for Robinhood mainnet) */
  @Column({ type: 'integer' })
  chain_id: number;

  /** ERC-20 / NFT contract address (lowercase, 0x-prefixed, 42 chars) */
  @Column({ type: 'varchar', length: 42 })
  token_address: string;

  /** Chainlink AggregatorV3 proxy address for this token */
  @Column({ type: 'varchar', length: 42 })
  chainlink_feed_address: string;

  /** Maximum acceptable age of a Chainlink answer in seconds (default 3 600) */
  @Column({ type: 'integer', default: 3600 })
  max_age_seconds: number;

  /** When false this feed entry is ignored during price resolution */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * When false the DexScreener fallback is skipped for this token.
   * Set to false for regulated/stock tokens where only Chainlink is trusted.
   */
  @Column({ type: 'boolean', default: true })
  allow_dexscreener_fallback: boolean;

  @BeforeInsert()
  @BeforeUpdate()
  normalizeAddresses(): void {
    this.token_address = this.token_address.toLowerCase();
    this.chainlink_feed_address = this.chainlink_feed_address.toLowerCase();
  }
}
