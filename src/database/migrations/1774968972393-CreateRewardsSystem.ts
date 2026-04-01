import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * l4va-api migration: Creates only what l4va-api owns.
 * - events schema
 * - events.outbox: outbox table for reward events (polled by l4va-rewards)
 * - vault_weight column on vaults table
 *
 * ALL reward processing tables (epochs, activity_events, scores, etc.)
 * are created by l4va-rewards via its own migration.
 */
export class CreateRewardsSystem1774968972393 implements MigrationInterface {
  name = 'CreateRewardsSystem1774968972393';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Create schema & extensions ---
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "events"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // --- Enum (safe create) ---
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'outbox_status_enum'
          AND n.nspname = 'events'
        ) THEN
          CREATE TYPE "events"."outbox_status_enum" AS ENUM ('pending', 'processed', 'failed');
        END IF;
      END$$;
    `);

    // --- events.outbox ---
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "events"."outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "aggregate_id" uuid NOT NULL,
        "aggregate_type" character varying NOT NULL,
        "event_type" character varying NOT NULL,
        "event_data" jsonb NOT NULL,
        "idempotency_key" character varying,
        "status" "events"."outbox_status_enum" NOT NULL DEFAULT 'pending',
        "attempt" integer NOT NULL DEFAULT 0,
        "max_attempts" integer NOT NULL DEFAULT 5,
        "error_message" text,
        "next_retry_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "processed_at" TIMESTAMP WITH TIME ZONE,
        "updated_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_events_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_outbox_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);

    // --- Indexes (safe) ---
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_outbox_status" ON "events"."outbox" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_outbox_event_type" ON "events"."outbox" ("event_type")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_outbox_status_created" ON "events"."outbox" ("status", "created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_outbox_aggregate_id" ON "events"."outbox" ("aggregate_id")`
    );

    // --- Add vault_weight ---
    await queryRunner.query(`
      ALTER TABLE "vaults"
      ADD COLUMN IF NOT EXISTS "vault_weight" numeric(10,4) NOT NULL DEFAULT '1'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // --- Safe rollback ---
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "vault_weight"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "events"."outbox"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "events"."outbox_status_enum"`);

    await queryRunner.query(`DROP SCHEMA IF EXISTS "events" CASCADE`);
  }
}
