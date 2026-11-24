import { MigrationInterface, QueryRunner } from 'typeorm';

/** Creator Challenge v0.1: seasons, auto-entered vaults and hourly price/value snapshots. */
export class AddCompetition1794480000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "competition_seasons" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" varchar NOT NULL,
        "title" varchar NOT NULL,
        "start_at" timestamptz NOT NULL,
        "entry_cutoff_at" timestamptz NOT NULL,
        "promo_end_at" timestamptz,
        "end_at" timestamptz NOT NULL,
        "min_liquidity_usd" numeric NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_competition_seasons" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_competition_seasons_slug" UNIQUE ("slug")
      )`);
    await queryRunner.query(`
      CREATE TABLE "competition_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "season_id" uuid NOT NULL REFERENCES "competition_seasons"("id") ON DELETE CASCADE,
        "vault_id" uuid NOT NULL REFERENCES "vaults"("id") ON DELETE CASCADE,
        "entered_at" timestamptz NOT NULL,
        "entry_price_usd" numeric NOT NULL,
        "entry_value_usd" numeric NOT NULL DEFAULT 0,
        "status" varchar NOT NULL DEFAULT 'active',
        CONSTRAINT "PK_competition_entries" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_competition_entries_season_vault" ON "competition_entries" ("season_id", "vault_id")`
    );
    await queryRunner.query(`
      CREATE TABLE "competition_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "season_id" uuid NOT NULL REFERENCES "competition_seasons"("id") ON DELETE CASCADE,
        "vault_id" uuid NOT NULL REFERENCES "vaults"("id") ON DELETE CASCADE,
        "taken_at" timestamptz NOT NULL,
        "price_usd" numeric NOT NULL,
        "value_usd" numeric NOT NULL DEFAULT 0,
        "fdv_usd" numeric NOT NULL DEFAULT 0,
        "liquidity_usd" numeric NOT NULL DEFAULT 0,
        "holders" integer,
        CONSTRAINT "PK_competition_snapshots" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_competition_snapshots_season_vault_taken" ON "competition_snapshots" ("season_id", "vault_id", "taken_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "competition_snapshots"`);
    await queryRunner.query(`DROP TABLE "competition_entries"`);
    await queryRunner.query(`DROP TABLE "competition_seasons"`);
  }
}
