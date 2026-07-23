import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foundations for the lock-time EVM pricing pipeline.
 *
 * Changes:
 *  - assets_whitelist.custom_price_native_wei numeric(78,0) NULL
 *      Per-collection manual/floor price in wei per whole unit
 *      (ERC-20: per whole token; ERC-721/1155: per NFT).
 *  - evm_asset_price_feeds.quote_asset varchar(16) NOT NULL DEFAULT 'native'
 *      What denomination the Chainlink feed answer is in.
 *      Allowed: 'native' (wei per whole token), 'usd' (USD * 10^feed_decimals).
 *      USD-quoted feeds require a companion ETH/USD feed at lock time; the
 *      pricer will reject them until that path is implemented.
 *  - evm_asset_price_feeds.feed_decimals smallint NULL
 *      Cached Chainlink decimals(). Optional — pricer falls back to
 *      readContract at compute time if null.
 *  - evm_contribution_valuations.unit_price_native → numeric(78,0)
 *      Was numeric(78,18) which forces Postgres to scale-shift the value.
 *      Wei is already the smallest unit, so scale=0 round-trips faithfully
 *      via ColumnBigintStringTransformer.
 *  - evm_contribution_valuations.amount_normalized → numeric(78,0)
 *      Same reasoning — dropping the fractional scale.
 */
export class AddLockTimePricingFoundations1784812507645 implements MigrationInterface {
  name = 'AddLockTimePricingFoundations1784812507645';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets_whitelist"
        ADD COLUMN IF NOT EXISTS "custom_price_native_wei" numeric(78, 0) NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "assets_whitelist"."custom_price_native_wei" IS
        'EVM: per-collection manual/floor price in wei per whole unit (ERC-20: per whole token; ERC-721/1155: per NFT). Overrides Chainlink for this vault.'
    `);

    await queryRunner.query(`
      ALTER TABLE "evm_asset_price_feeds"
        ADD COLUMN IF NOT EXISTS "quote_asset" varchar(16) NOT NULL DEFAULT 'native',
        ADD COLUMN IF NOT EXISTS "feed_decimals" smallint NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "evm_asset_price_feeds"."quote_asset" IS
        'Denomination of the Chainlink answer. native = wei per whole token; usd = USD * 10^feed_decimals.'
    `);

    await queryRunner.query(`
      ALTER TABLE "evm_contribution_valuations"
        ALTER COLUMN "unit_price_native" TYPE numeric(78, 0) USING ROUND("unit_price_native" * POWER(10, 18)),
        ALTER COLUMN "amount_normalized" TYPE numeric(78, 0) USING ROUND("amount_normalized" * POWER(10, 18))
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "evm_contribution_valuations"."unit_price_native" IS
        'Wei per whole unit (ERC-20: per whole token; NFT: per token; Native: 1). Stored as bigint via ColumnBigintStringTransformer.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert numeric scale — divide-back may lose precision but that only
    // matters for values previously stored under the old float scale.
    await queryRunner.query(`
      ALTER TABLE "evm_contribution_valuations"
        ALTER COLUMN "unit_price_native" TYPE numeric(78, 18) USING ("unit_price_native" / POWER(10, 18)),
        ALTER COLUMN "amount_normalized" TYPE numeric(78, 18) USING ("amount_normalized" / POWER(10, 18))
    `);

    await queryRunner.query(`
      ALTER TABLE "evm_asset_price_feeds"
        DROP COLUMN IF EXISTS "feed_decimals",
        DROP COLUMN IF EXISTS "quote_asset"
    `);

    await queryRunner.query(`
      ALTER TABLE "assets_whitelist" DROP COLUMN IF EXISTS "custom_price_native_wei"
    `);
  }
}
