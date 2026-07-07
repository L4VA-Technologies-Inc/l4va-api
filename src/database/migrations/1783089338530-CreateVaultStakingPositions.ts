import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVaultStakingPositions1783089338530 implements MigrationInterface {
  name = 'CreateVaultStakingPositions1783089338530';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."vault_staking_positions_status_enum"
        AS ENUM('pending', 'staked', 'harvesting', 'unstaked', 'failed')
    `);

    await queryRunner.query(`
      CREATE TABLE "vault_staking_positions" (
        "id"                  uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "vault_id"            uuid              NOT NULL,
        "platform"            character varying(64) NOT NULL,
        "stake_collection_id" integer           NOT NULL,
        "stake_id"            character varying(64),
        "status"              "public"."vault_staking_positions_status_enum"
                              NOT NULL DEFAULT 'pending',
        "stake_tx_hash"       character varying,
        "unstake_tx_hash"     character varying,
        "asset_ids"           jsonb             NOT NULL DEFAULT '[]',
        "started_at"          TIMESTAMP WITH TIME ZONE,
        "ended_at"            TIMESTAMP WITH TIME ZONE,
        "raw_stake_response"  jsonb,
        "raw_harvest_response" jsonb,
        "created_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vault_staking_positions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "vault_staking_positions"
        ADD CONSTRAINT "FK_vault_staking_positions_vault"
        FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_vsp_vault_platform"
        ON "vault_staking_positions" ("vault_id", "platform")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_vsp_status"
        ON "vault_staking_positions" ("status")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_vsp_stake_id"
        ON "vault_staking_positions" ("stake_id")
        WHERE "stake_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_vsp_stake_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vsp_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_vsp_vault_platform"`);
    await queryRunner.query(`
      ALTER TABLE "vault_staking_positions"
        DROP CONSTRAINT "FK_vault_staking_positions_vault"
    `);
    await queryRunner.query(`DROP TABLE "vault_staking_positions"`);
    await queryRunner.query(`DROP TYPE "public"."vault_staking_positions_status_enum"`);
  }
}
