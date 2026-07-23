import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EVM reconciliation status on the `transactions` table.
 *
 * Every EVM transaction is considered "fully processed" only after both:
 *   (a) its receipt is successful (existing status='confirmed'), AND
 *   (b) every relevant Vault event it emitted has been reconciled into the
 *       domain-specific tables (evm_contributions, evm_allocations, etc.).
 *
 * The Alchemy webhook is the fast path. The transaction-health checker
 * (cron) is the durable retry path — for confirmed EVM txs whose
 * reconciliation is pending or has failed, it re-fetches the receipt and
 * calls EvmVaultEventReconciler.reconcileLogs until success or the attempt
 * cap is hit.
 *
 * Columns:
 *   reconciliation_status    NULL for Cardano rows; enum for EVM rows.
 *   reconciliation_attempts  Incremented on every retry; capped by the caller.
 *   reconciliation_last_error Last error message (truncated to keep row small).
 *   reconciled_at            Set exactly once when reconciliation succeeds.
 */
export class AddEvmReconciliationStatus1784813785098 implements MigrationInterface {
  name = 'AddEvmReconciliationStatus1784813785098';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "evm_reconciliation_status_enum" AS ENUM ('pending', 'success', 'failed')
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
        ADD COLUMN IF NOT EXISTS "reconciliation_status" "evm_reconciliation_status_enum" NULL,
        ADD COLUMN IF NOT EXISTS "reconciliation_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "reconciliation_last_error" text NULL,
        ADD COLUMN IF NOT EXISTS "reconciled_at" timestamptz NULL
    `);

    // Partial index for the cron's hot query: EVM confirmed rows still waiting
    // to reconcile.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_evm_reconcile_pending"
        ON "transactions" ("updated_at")
        WHERE "reconciled_at" IS NULL
          AND "reconciliation_status" IS DISTINCT FROM 'failed'
          AND "chain_id" IS NOT NULL
          AND "status" = 'confirmed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_transactions_evm_reconcile_pending"`);
    await queryRunner.query(`
      ALTER TABLE "transactions"
        DROP COLUMN IF EXISTS "reconciled_at",
        DROP COLUMN IF EXISTS "reconciliation_last_error",
        DROP COLUMN IF EXISTS "reconciliation_attempts",
        DROP COLUMN IF EXISTS "reconciliation_status"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "evm_reconciliation_status_enum"`);
  }
}
