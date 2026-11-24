import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExtendMarketsForRobinhoodTokens1788251520000 implements MigrationInterface {
  name = 'ExtendMarketsForRobinhoodTokens1788251520000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."markets_type_enum" AS ENUM('vault_token', 'robinhood_token')`);
    await queryRunner.query(`CREATE TYPE "public"."markets_token_kind_enum" AS ENUM('memecoin', 'rwa', 'nft')`);

    await queryRunner.query(`ALTER TABLE "markets" ALTER COLUMN "vault_id" DROP NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "markets" ADD "type" "public"."markets_type_enum" NOT NULL DEFAULT 'vault_token'`
    );
    await queryRunner.query(`ALTER TABLE "markets" ADD "token_kind" "public"."markets_token_kind_enum"`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "name" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "symbol" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "image_url" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "contract_address" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "pair_address" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "policy_id" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "asset_name" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "decimals" smallint`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "holders_count" integer`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "dex_id" character varying`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "price_usd" numeric(20,8)`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "fdv" numeric(20,8)`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "volume_24h" numeric(20,8)`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "liquidity_usd" numeric(20,8)`);
    await queryRunner.query(`ALTER TABLE "markets" ADD "score" numeric(12,4)`);

    await queryRunner.query(`CREATE INDEX "IDX_markets_type" ON "markets" ("type")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_markets_vault_id" ON "markets" ("vault_id") WHERE "vault_id" IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_markets_contract_address" ON "markets" ("contract_address") WHERE "contract_address" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_markets_contract_address"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_markets_vault_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_markets_type"`);

    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "score"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "liquidity_usd"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "volume_24h"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "fdv"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "price_usd"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "dex_id"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "holders_count"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "decimals"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "asset_name"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "policy_id"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "pair_address"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "contract_address"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "image_url"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "symbol"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "name"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "token_kind"`);
    await queryRunner.query(`ALTER TABLE "markets" DROP COLUMN "type"`);

    await queryRunner.query(`ALTER TABLE "markets" ALTER COLUMN "vault_id" SET NOT NULL`);

    await queryRunner.query(`DROP TYPE "public"."markets_token_kind_enum"`);
    await queryRunner.query(`DROP TYPE "public"."markets_type_enum"`);
  }
}
