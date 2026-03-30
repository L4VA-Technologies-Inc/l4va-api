import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * l4va-api migration: Creates only what l4va-api owns.
 * - reward_event_outbox: outbox table for reward events (polled by l4va-rewards)
 * - vault_weight column on vaults table
 *
 * ALL reward processing tables (epochs, activity_events, scores, etc.)
 * are created by l4va-rewards via its own migration.
 */
export class CreateRewardsSystem1773306735000 implements MigrationInterface {
  name = 'CreateRewardsSystem1773306735000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Enum types ---
    await queryRunner.query(
      `CREATE TYPE "public"."reward_event_outbox_event_type_enum" AS ENUM('asset_contribution', 'token_acquire', 'acquire_phase_purchase', 'expansion_asset_contribution', 'expansion_token_purchase', 'lp_position_update', 'widget_swap', 'governance_proposal', 'governance_vote')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reward_event_outbox_status_enum" AS ENUM('pending', 'processed', 'failed')`
    );

    // --- reward_event_outbox ---
    await queryRunner.query(`
      CREATE TABLE "reward_event_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_address" character varying NOT NULL,
        "vault_id" uuid,
        "event_type" "public"."reward_event_outbox_event_type_enum" NOT NULL,
        "asset_id" character varying,
        "tx_hash" character varying,
        "event_timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
        "units" numeric(20,6) NOT NULL DEFAULT '1',
        "metadata" jsonb,
        "status" "public"."reward_event_outbox_status_enum" NOT NULL DEFAULT 'pending',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_reward_event_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_reo_status" ON "reward_event_outbox" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_reo_wallet_address" ON "reward_event_outbox" ("wallet_address")`);
    await queryRunner.query(`CREATE INDEX "IDX_reo_event_type" ON "reward_event_outbox" ("event_type")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_reo_status_created" ON "reward_event_outbox" ("status", "created_at")`
    );

    // --- Add vault_weight to vaults ---
    await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_weight" numeric(10,4) NOT NULL DEFAULT '1'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_weight"`);
    await queryRunner.query(`DROP TABLE "reward_event_outbox"`);
    await queryRunner.query(`DROP TYPE "public"."reward_event_outbox_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_event_outbox_event_type_enum"`);
  }
}
