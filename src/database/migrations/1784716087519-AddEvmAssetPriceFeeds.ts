import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvmAssetPriceFeeds1784716087519 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "evm_asset_price_feeds" (
        "id"                          uuid          NOT NULL DEFAULT gen_random_uuid(),
        "chain_id"                    integer       NOT NULL,
        "token_address"               varchar(42)   NOT NULL,
        "chainlink_feed_address"      varchar(42)   NOT NULL,
        "max_age_seconds"             integer       NOT NULL DEFAULT 3600,
        "enabled"                     boolean       NOT NULL DEFAULT true,
        "allow_dexscreener_fallback"  boolean       NOT NULL DEFAULT true,
        CONSTRAINT "PK_evm_asset_price_feeds"              PRIMARY KEY ("id"),
        CONSTRAINT "UQ_evm_asset_price_feeds_chain_token"  UNIQUE ("chain_id", "token_address")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "evm_asset_price_feeds"`);
  }
}
