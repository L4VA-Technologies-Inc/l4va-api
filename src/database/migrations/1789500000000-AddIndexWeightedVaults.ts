import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndexWeightedVaults1789500000000 implements MigrationInterface {
  name = 'AddIndexWeightedVaults1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_archetype" character varying NOT NULL DEFAULT 'standard'`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "index_config" jsonb`);
    await queryRunner.query(`CREATE INDEX "IDX_vaults_vault_archetype" ON "vaults" ("vault_archetype")`);

    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-swap'`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" ADD VALUE IF NOT EXISTS 'index_reweight'`
    );

    await queryRunner.query(`
      CREATE TABLE "evm_index_rebalances" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "vault_id" uuid NOT NULL,
        "idempotency_key" character varying NOT NULL,
        "trigger" character varying NOT NULL,
        "proposal_id" uuid,
        "status" character varying NOT NULL DEFAULT 'pending',
        "phase" character varying NOT NULL DEFAULT 'sells',
        "targets" jsonb NOT NULL,
        "reserve_bps" integer NOT NULL,
        "nav_native" numeric(78,0),
        "legs" jsonb NOT NULL DEFAULT '[]',
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_evm_index_rebalances_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_evm_index_rebalances_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_evm_index_rebalances_vault_key" ON "evm_index_rebalances" ("vault_id", "idempotency_key")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_evm_index_rebalances_vault_created" ON "evm_index_rebalances" ("vault_id", "created_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_evm_index_rebalances_vault_created"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_evm_index_rebalances_vault_key"`);
    await queryRunner.query(`DROP TABLE "evm_index_rebalances"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vaults_vault_archetype"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "index_config"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_archetype"`);
    // Postgres cannot drop enum values; 'evm-swap' and 'index_reweight' stay defined but unused.
  }
}
