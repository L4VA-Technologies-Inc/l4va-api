import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EVM domain-event reconciliation on the `transactions` table.
 *
 * An EVM transaction is not "fully processed" merely because its receipt is
 * successful — it is complete only after every relevant Vault event it
 * emitted has been reconciled into the domain-specific tables
 * (evm_contributions, evm_allocations, etc.).
 *
 * The Alchemy webhook is the fast path. The transaction-health checker
 * (cron) is the durable retry path — for confirmed EVM txs whose
 * reconciliation is pending, it re-fetches the receipt and calls
 * EvmVaultEventReconciler.reconcileLogs until success or the attempt cap.
 *
 * Columns:
 *   reconciliation_status     'pending' | 'success' | 'failed' | 'manual_review_required'.
 *                             Defaults NULL for legacy Cardano rows. EVM admin
 *                             broadcasts SET IT to 'pending' explicitly.
 *   reconciliation_attempts   Incremented on every retry; capped by the caller.
 *   reconciliation_last_error Last error message (truncated to keep row small).
 *   reconciled_at             Set exactly once when reconciliation succeeds.
 *   expected_events           JSONB array of event descriptors the reconciler
 *                             MUST see for this tx to be considered complete.
 *                             Example: [{ name: 'CycleClosed', count: 1 }].
 *                             NULL means "no expectations" — used for legacy
 *                             / unrelated txs. Any non-empty spec must be
 *                             fully satisfied before reconciled_at is set.
 */
export class AddEvmReconciliationStatus1784813785098 implements MigrationInterface {
  name = 'AddEvmReconciliationStatus1784813785098';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "evm_reconciliation_status_enum" AS ENUM
        ('pending', 'success', 'failed', 'manual_review_required')
    `);

    await queryRunner.query(`
      ALTER TABLE "transactions"
        ADD COLUMN IF NOT EXISTS "reconciliation_status" "evm_reconciliation_status_enum" NULL,
        ADD COLUMN IF NOT EXISTS "reconciliation_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "reconciliation_last_error" text NULL,
        ADD COLUMN IF NOT EXISTS "reconciled_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "expected_events" jsonb NULL
    `);

    // Partial index for the cron's hot query: EVM confirmed rows still
    // waiting to reconcile.
    //
    // NOTE: `IS DISTINCT FROM` treats NULL as a distinct value, so rows with
    // reconciliation_status IS NULL are INCLUDED in the index. Plain `!=`
    // would silently exclude NULLs.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_evm_reconcile_pending"
        ON "transactions" ("updated_at")
        WHERE "reconciled_at" IS NULL
          AND "reconciliation_status" IS DISTINCT FROM 'failed'
          AND "reconciliation_status" IS DISTINCT FROM 'manual_review_required'
          AND "chain_id" IS NOT NULL
          AND "status" = 'confirmed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_transactions_evm_reconcile_pending"`);
    await queryRunner.query(`
      ALTER TABLE "transactions"
        DROP COLUMN IF EXISTS "expected_events",
        DROP COLUMN IF EXISTS "reconciled_at",
        DROP COLUMN IF EXISTS "reconciliation_last_error",
        DROP COLUMN IF EXISTS "reconciliation_attempts",
        DROP COLUMN IF EXISTS "reconciliation_status"
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS "evm_reconciliation_status_enum"`);
  }
}
