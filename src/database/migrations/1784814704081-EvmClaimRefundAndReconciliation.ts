import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Combined EVM migrations (all-in-one):
 *
 * This migration consolidates 5 related EVM infrastructure changes:
 * 1. AddEvmClaimRefundFoundations — claim/refund/cycle-close foundations
 * 2. ExtendEvmSnapshotStatusEnum — crash-safe reconciliation states
 * 3. AddLockTimePricingFoundations — pricing pipeline foundations
 * 4. AddEvmReconciliationStatus — domain-event reconciliation
 * 5. AddClaimBlockNumberToEvmAllocations — claim audit trail
 *
 * Runs in chronological order during up(); reverses during down().
 */
export class EvmClaimRefundAndReconciliation1784814704081 implements MigrationInterface {
  name = 'EvmClaimRefundAndReconciliation1784814704081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // PHASE 1: AddEvmClaimRefundFoundations (1784808785919)
    // =========================================================================
    // Enum additions (Postgres: ALTER TYPE ... ADD VALUE)
    await queryRunner.query(`ALTER TYPE "transactions_status_enum" ADD VALUE IF NOT EXISTS 'refunded'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-close-cycle'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-claim'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-refund'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-cancel-cycle'`);

    // vaults — cycle-close bookkeeping (no threshold column: use getCycle view)
    await queryRunner.query(`
      ALTER TABLE "vaults"
        ADD COLUMN IF NOT EXISTS "evm_current_cycle_id" bigint NULL,
        ADD COLUMN IF NOT EXISTS "evm_allocation_root" varchar(66) NULL,
        ADD COLUMN IF NOT EXISTS "evm_close_cycle_tx_hash" varchar(66) NULL,
        ADD COLUMN IF NOT EXISTS "evm_root_committed_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "evm_cancel_cycle_tx_hash" varchar(66) NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "vaults"."evm_root_committed_at" IS
        'Set ONLY after a CycleClosed event is decoded from the receipt and every field exactly matches the prepared snapshot.'
    `);

    // transactions — refund linkage only (contribution IDs live in evm_contributions)
    await queryRunner.query(`
      ALTER TABLE "transactions"
        ADD COLUMN IF NOT EXISTS "refund_tx_hash" varchar(66) NULL,
        ADD COLUMN IF NOT EXISTS "refunded_at" timestamptz NULL
    `);

    // evm_contribution_status_enum — mirrors Solidity ContributionStatus.
    // Active on creation; Refunded after ContributionCancelled event is
    // decoded and validated by the operation service.
    await queryRunner.query(`
      CREATE TYPE "evm_contribution_status_enum" AS ENUM ('active', 'refunded')
    `);

    // evm_contributions — canonical mapping: 1 row per on-chain contribution.
    // Guarantees exactly-once idempotent refund updates keyed on
    // (vault_id, on_chain_contribution_id).
    await queryRunner.query(`
      CREATE TABLE "evm_contributions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "transaction_id" uuid NOT NULL,
        "asset_id" uuid NULL,
        "vault_id" uuid NOT NULL,
        "cycle_id" bigint NOT NULL,
        "on_chain_contribution_id" numeric(78, 0) NOT NULL,
        "contribution_tx_hash" varchar(66) NOT NULL,
        "log_index" integer NULL,
        "block_number" bigint NULL,
        "contributor" varchar(42) NOT NULL,
        "kind" smallint NOT NULL,
        "asset" varchar(42) NOT NULL,
        "token_id" numeric(78, 0) NOT NULL DEFAULT 0,
        "amount" numeric(78, 0) NOT NULL,
        "status" "evm_contribution_status_enum" NOT NULL DEFAULT 'active',
        "refund_tx_hash" varchar(66) NULL,
        "refunded_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "uq_evm_contributions_vault_onchain"
          UNIQUE ("vault_id", "on_chain_contribution_id"),
        CONSTRAINT "fk_evm_contributions_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_evm_contributions_asset"
          FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL,
        CONSTRAINT "fk_evm_contributions_vault"
          FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_contributions_contributor" ON "evm_contributions" ("contributor")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_contributions_vault_cycle" ON "evm_contributions" ("vault_id", "cycle_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_contributions_transaction" ON "evm_contributions" ("transaction_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_contributions_status" ON "evm_contributions" ("status")
    `);

    // evm_valuation_snapshots — one row per (vault_id, cycle_id).
    // Full audit record: prices, valuations, root, hash, totals, status machine.
    await queryRunner.query(`
      CREATE TYPE "evm_snapshot_status_enum" AS ENUM
        ('calculated', 'ready', 'submitted', 'confirmed', 'failed')
    `);
    await queryRunner.query(`
      CREATE TABLE "evm_valuation_snapshots" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "vault_id" uuid NOT NULL,
        "cycle_id" bigint NOT NULL,
        "schema_version" integer NOT NULL DEFAULT 1,
        "price_source" jsonb NOT NULL,
        "price_timestamp" timestamptz NOT NULL,
        "raw_prices" jsonb NOT NULL,
        "normalized_prices" jsonb NOT NULL,
        "total_native_raised" numeric(78, 0) NOT NULL DEFAULT 0,
        "total_asset_value_native" numeric(78, 0) NOT NULL DEFAULT 0,
        "fdv_native" numeric(78, 0) NOT NULL DEFAULT 0,
        "vt_price" numeric(78, 18) NOT NULL DEFAULT 0,
        "lp_carveout" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "merkle_root" varchar(66) NULL,
        "valuation_hash" varchar(66) NULL,
        "total_vt_allocation" numeric(78, 0) NOT NULL DEFAULT 0,
        "total_native_allocation" numeric(78, 0) NOT NULL DEFAULT 0,
        "status" "evm_snapshot_status_enum" NOT NULL DEFAULT 'calculated',
        "submit_tx_hash" varchar(66) NULL,
        "confirmed_at" timestamptz NULL,
        "failure_reason" text NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "uq_evm_snapshots_vault_cycle"
          UNIQUE ("vault_id", "cycle_id"),
        CONSTRAINT "fk_evm_snapshots_vault"
          FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_snapshots_status" ON "evm_valuation_snapshots" ("status")
    `);

    // evm_contribution_valuations — per-contribution valuation row.
    // FKs to evm_contributions when a matching on-chain record exists.
    await queryRunner.query(`
      CREATE TABLE "evm_contribution_valuations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "snapshot_id" uuid NOT NULL,
        "evm_contribution_id" uuid NOT NULL,
        "on_chain_contribution_id" numeric(78, 0) NOT NULL,
        "contributor" varchar(42) NOT NULL,
        "kind" smallint NOT NULL,
        "asset" varchar(42) NOT NULL,
        "token_id" numeric(78, 0) NOT NULL DEFAULT 0,
        "amount_raw" numeric(78, 0) NOT NULL,
        "amount_normalized" numeric(78, 18) NOT NULL,
        "unit_price_native" numeric(78, 18) NOT NULL,
        "value_native" numeric(78, 0) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "fk_evm_valuations_snapshot"
          FOREIGN KEY ("snapshot_id") REFERENCES "evm_valuation_snapshots"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_evm_valuations_contribution"
          FOREIGN KEY ("evm_contribution_id") REFERENCES "evm_contributions"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_valuations_snapshot" ON "evm_contribution_valuations" ("snapshot_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_valuations_contributor" ON "evm_contribution_valuations" ("contributor")
    `);

    // evm_allocations — one row per Merkle leaf.
    // (vault_id, cycle_id, claim_index) is unique — matches the on-chain leaf.
    await queryRunner.query(`
      CREATE TABLE "evm_allocations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "snapshot_id" uuid NOT NULL,
        "vault_id" uuid NOT NULL,
        "cycle_id" bigint NOT NULL,
        "claim_index" bigint NOT NULL,
        "contributor" varchar(42) NOT NULL,
        "vt_amount" numeric(78, 0) NOT NULL,
        "native_amount" numeric(78, 0) NOT NULL,
        "proof" jsonb NOT NULL,
        "claimed_at" timestamptz NULL,
        "claim_tx_hash" varchar(66) NULL,
        "created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "uq_evm_allocations_vault_cycle_index"
          UNIQUE ("vault_id", "cycle_id", "claim_index"),
        CONSTRAINT "fk_evm_allocations_snapshot"
          FOREIGN KEY ("snapshot_id") REFERENCES "evm_valuation_snapshots"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_evm_allocations_vault"
          FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_allocations_contributor" ON "evm_allocations" ("contributor")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_evm_allocations_unclaimed"
        ON "evm_allocations" ("vault_id", "cycle_id")
        WHERE "claimed_at" IS NULL
    `);

    // =========================================================================
    // PHASE 2: ExtendEvmSnapshotStatusEnum (1784812051120)
    // =========================================================================
    // Extend evm_snapshot_status_enum with two states that make the close-cycle
    // pipeline crash-safe and reconcilable:
    //   submitting — writeContract issued but the tx hash is not yet persisted.
    //   reconciliation_required — receipt successful BUT events didn't match.
    await queryRunner.query(`ALTER TYPE "evm_snapshot_status_enum" ADD VALUE IF NOT EXISTS 'submitting'`);
    await queryRunner.query(`ALTER TYPE "evm_snapshot_status_enum" ADD VALUE IF NOT EXISTS 'reconciliation_required'`);

    // =========================================================================
    // PHASE 3: AddLockTimePricingFoundations (1784812507645)
    // =========================================================================
    // assets_whitelist: per-collection manual/floor price in wei
    await queryRunner.query(`
      ALTER TABLE "assets_whitelist"
        ADD COLUMN IF NOT EXISTS "custom_price_native_wei" numeric(78, 0) NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "assets_whitelist"."custom_price_native_wei" IS
        'EVM: per-collection manual/floor price in wei per whole unit (ERC-20: per whole token; ERC-721/1155: per NFT). Overrides Chainlink for this vault.'
    `);

    // evm_asset_price_feeds: quote asset denomination and cached decimals
    await queryRunner.query(`
      ALTER TABLE "evm_asset_price_feeds"
        ADD COLUMN IF NOT EXISTS "quote_asset" varchar(16) NOT NULL DEFAULT 'native',
        ADD COLUMN IF NOT EXISTS "feed_decimals" smallint NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "evm_asset_price_feeds"."quote_asset" IS
        'Denomination of the Chainlink answer. native = wei per whole token; usd = USD * 10^feed_decimals.'
    `);

    // evm_contribution_valuations: change numeric scale for wei precision
    await queryRunner.query(`
      ALTER TABLE "evm_contribution_valuations"
        ALTER COLUMN "unit_price_native" TYPE numeric(78, 0) USING ROUND("unit_price_native" * POWER(10, 18)),
        ALTER COLUMN "amount_normalized" TYPE numeric(78, 0) USING ROUND("amount_normalized" * POWER(10, 18))
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "evm_contribution_valuations"."unit_price_native" IS
        'Wei per whole unit (ERC-20: per whole token; NFT: per token; Native: 1). Stored as bigint via ColumnBigintStringTransformer.'
    `);

    // =========================================================================
    // PHASE 4: AddEvmReconciliationStatus (1784813785098)
    // =========================================================================
    // EVM domain-event reconciliation enum and columns on transactions
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

    // Partial index for the cron's hot query: EVM confirmed rows still waiting to reconcile.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transactions_evm_reconcile_pending"
        ON "transactions" ("updated_at")
        WHERE "reconciled_at" IS NULL
          AND "reconciliation_status" IS DISTINCT FROM 'failed'
          AND "reconciliation_status" IS DISTINCT FROM 'manual_review_required'
          AND "chain_id" IS NOT NULL
          AND "status" = 'confirmed'
    `);

    // =========================================================================
    // PHASE 5: AddClaimBlockNumberToEvmAllocations (1784814704081)
    // =========================================================================
    // Persist the block number the AllocationClaimed event was emitted in
    await queryRunner.query(`
      ALTER TABLE "evm_allocations"
        ADD COLUMN IF NOT EXISTS "claim_block_number" bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: PHASE 5, 4, 3, 2, 1

    // =========================================================================
    // PHASE 5 DOWN: AddClaimBlockNumberToEvmAllocations
    // =========================================================================
    await queryRunner.query(`ALTER TABLE "evm_allocations" DROP COLUMN IF EXISTS "claim_block_number"`);

    // =========================================================================
    // PHASE 4 DOWN: AddEvmReconciliationStatus
    // =========================================================================
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

    // =========================================================================
    // PHASE 3 DOWN: AddLockTimePricingFoundations
    // =========================================================================
    // Revert numeric scale — divide-back may lose precision but that only
    // matters for values previously stored under the old float scale.
    await queryRunner.query(`
      ALTER TABLE "evm_contribution_valuations"
        ALTER COLUMN "unit_price_native" TYPE numeric(78, 18) USING ("unit_price_native" / POWER(10, 18)),
        ALTER COLUMN "amount_normalized" TYPE numeric(78, 18) USING ("amount_normalized" / POWER(10, 18))
    `);

    await queryRunner.query(`
      ALTER TABLE "evm_asset_price_feeds"
        DROP COLUMN IF EXISTS "feed_decimals",
        DROP COLUMN IF EXISTS "quote_asset"
    `);

    await queryRunner.query(`
      ALTER TABLE "assets_whitelist" DROP COLUMN IF EXISTS "custom_price_native_wei"
    `);

    // =========================================================================
    // PHASE 2 DOWN: ExtendEvmSnapshotStatusEnum
    // =========================================================================
    // Postgres does not support DROP VALUE from an enum. Leaving the added
    // values in place on downgrade is safe — they simply become unused.

    // =========================================================================
    // PHASE 1 DOWN: AddEvmClaimRefundFoundations
    // =========================================================================
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_allocations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_contribution_valuations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_valuation_snapshots"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "evm_snapshot_status_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_contributions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "evm_contribution_status_enum"`);

    await queryRunner.query(`
      ALTER TABLE "transactions"
        DROP COLUMN IF EXISTS "refunded_at",
        DROP COLUMN IF EXISTS "refund_tx_hash"
    `);

    await queryRunner.query(`
      ALTER TABLE "vaults"
        DROP COLUMN IF EXISTS "evm_cancel_cycle_tx_hash",
        DROP COLUMN IF EXISTS "evm_root_committed_at",
        DROP COLUMN IF EXISTS "evm_close_cycle_tx_hash",
        DROP COLUMN IF EXISTS "evm_allocation_root",
        DROP COLUMN IF EXISTS "evm_current_cycle_id"
    `);

    // NOTE: Postgres cannot easily DROP VALUE from an enum. Leaving 'refunded' /
    // 'evm-*' values in place on downgrade is safe — they simply become unused.
  }
}
