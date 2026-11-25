import { MigrationInterface, QueryRunner } from 'typeorm';

/** Public list of tokens index vaults can trade (the /supported-tokens page), written by swap-pool-review.ts. */
export class AddSupportedTokens1795610691244 implements MigrationInterface {
  name = 'AddSupportedTokens1795610691244';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "supported_tokens" (
        "chain_id" integer NOT NULL,
        "address" varchar(42) NOT NULL,
        "symbol" varchar(64) NOT NULL,
        "name" varchar(256) NOT NULL,
        "category" varchar(64) NOT NULL,
        "liquidity" varchar(8) NOT NULL,
        "round_trip_loss_bps" integer,
        "ref_eth" varchar(16) NOT NULL,
        "pool_ids" text[] NOT NULL DEFAULT '{}',
        "checked_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_supported_tokens" PRIMARY KEY ("chain_id", "address")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "supported_tokens"`);
  }
}
