import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase A — EVM claim / refund / cycle-close foundations.
 *
 * Adds:
 *  - vaults: evm_current_cycle_id / evm_allocation_root / evm_close_cycle_tx_hash /
 *    evm_root_committed_at / evm_cancel_cycle_tx_hash
 *    (min_acquire_threshold_eth intentionally NOT stored — Vault.getCycle().minAcquireThreshold
 *     and nativeCollected are the on-chain source of truth for close-vs-cancel decisions.)
 *  - transactions: refund_tx_hash, refunded_at
 *    (No on_chain_contribution_id here — one DB Transaction can hold many assets and thus
 *     many Solidity contributions. Contribution IDs live in evm_contributions.)
 *  - TransactionStatus enum: 'refunded'
 *  - TransactionType enum: 'evm-close-cycle', 'evm-claim', 'evm-refund', 'evm-cancel-cycle'
 *  - AssetStatus enum: 'refunded'
 *  - evm_valuation_snapshots  — full auditable dataset per (vault, cycle)
 *  - evm_contribution_valuations — per-contribution valuation rows fed into the Merkle tree
 *  - evm_allocations           — Merkle leaves + proofs
 *  - evm_contributions         — 1 row per on-chain Vault.contribution(id); maps a Solidity
 *                                contribution back to its DB transaction/asset with idempotency.
 *  - evm_snapshot_status_enum  — calculated/ready/submitted/confirmed/failed
 *  - evm_contribution_status_enum — active/refunded (mirrors Solidity ContributionStatus)
 */
export class AddEvmClaimRefundFoundations1784808785919 implements MigrationInterface {
  name = 'AddEvmClaimRefundFoundations1784808785919';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -------------------------------------------------------------------------
    // Enum additions (Postgres: ALTER TYPE ... ADD VALUE)
    // -------------------------------------------------------------------------
    await queryRunner.query(`ALTER TYPE "transactions_status_enum" ADD VALUE IF NOT EXISTS 'refunded'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-close-cycle'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-claim'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-refund'`);
    await queryRunner.query(`ALTER TYPE "transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-cancel-cycle'`);
    await queryRunner.query(`ALTER TYPE "assets_status_enum" ADD VALUE IF NOT EXISTS 'refunded'`);

    // -------------------------------------------------------------------------
    // vaults — cycle-close bookkeeping (no threshold column: use getCycle view)
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // transactions — refund linkage only (contribution IDs live in evm_contributions)
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "transactions"
        ADD COLUMN IF NOT EXISTS "refund_tx_hash" varchar(66) NULL,
        ADD COLUMN IF NOT EXISTS "refunded_at" timestamptz NULL
    `);

    // -------------------------------------------------------------------------
    // evm_contribution_status_enum — mirrors Solidity ContributionStatus.
    // Active on creation; Refunded after ContributionCancelled event is
    // decoded and validated by the operation service.
    // -------------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE "evm_contribution_status_enum" AS ENUM ('active', 'refunded')
    `);

    // -------------------------------------------------------------------------
    // evm_contributions — canonical mapping: 1 row per on-chain contribution.
    // Guarantees exactly-once idempotent refund updates keyed on
    // (vault_id, on_chain_contribution_id).
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // evm_valuation_snapshots — one row per (vault_id, cycle_id).
    // Full audit record: prices, valuations, root, hash, totals, status machine.
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // evm_contribution_valuations — per-contribution valuation row.
    // FKs to evm_contributions when a matching on-chain record exists.
    // -------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------
    // evm_allocations — one row per Merkle leaf.
    // (vault_id, cycle_id, claim_index) is unique — matches the on-chain leaf.
    // -------------------------------------------------------------------------
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
