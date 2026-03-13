import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRewardsSystem1773306735000 implements MigrationInterface {
  name = 'CreateRewardsSystem1773306735000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Enum types ---
    await queryRunner.query(
      `CREATE TYPE "public"."reward_epochs_status_enum" AS ENUM('active', 'processing', 'completed')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reward_activity_events_event_type_enum" AS ENUM('asset_contribution', 'token_acquire', 'acquire_phase_purchase', 'expansion_asset_contribution', 'expansion_token_purchase', 'lp_position_update', 'widget_swap', 'governance_proposal', 'governance_vote')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reward_activity_weights_activity_type_enum" AS ENUM('asset_contribution', 'token_acquire', 'acquire_phase_purchase', 'expansion_asset_contribution', 'expansion_token_purchase', 'lp_position_update', 'widget_swap', 'governance_proposal', 'governance_vote')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reward_vesting_positions_activity_type_enum" AS ENUM('asset_contribution', 'token_acquire', 'acquire_phase_purchase', 'expansion_asset_contribution', 'expansion_token_purchase', 'lp_position_update', 'widget_swap', 'governance_proposal', 'governance_vote')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."reward_vesting_positions_status_enum" AS ENUM('active', 'fully_unlocked', 'cancelled')`
    );
    await queryRunner.query(`CREATE TYPE "public"."reward_lp_positions_pool_type_enum" AS ENUM('vt_ada', 'vt_usdcx')`);
    await queryRunner.query(`CREATE TYPE "public"."reward_lp_positions_dex_enum" AS ENUM('vyfi', 'minswap')`);
    await queryRunner.query(`CREATE TYPE "public"."reward_claims_status_enum" AS ENUM('available', 'claimed')`);

    // --- reward_epochs ---
    await queryRunner.query(`
      CREATE TABLE "reward_epochs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "epoch_number" integer NOT NULL,
        "epoch_start" TIMESTAMP WITH TIME ZONE NOT NULL,
        "epoch_end" TIMESTAMP WITH TIME ZONE NOT NULL,
        "emission_total" bigint NOT NULL DEFAULT 1000000,
        "participant_pool" bigint NOT NULL DEFAULT 800000,
        "creator_pool" bigint NOT NULL DEFAULT 200000,
        "total_activity_score" numeric(30,6) NOT NULL DEFAULT '0',
        "status" "public"."reward_epochs_status_enum" NOT NULL DEFAULT 'active',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_reward_epochs_epoch_number" UNIQUE ("epoch_number"),
        CONSTRAINT "PK_reward_epochs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_reward_epochs_epoch_number" ON "reward_epochs" ("epoch_number")`);

    // --- reward_activity_events ---
    await queryRunner.query(`
      CREATE TABLE "reward_activity_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "epoch_id" uuid NOT NULL,
        "wallet_address" character varying NOT NULL,
        "vault_id" uuid,
        "event_type" "public"."reward_activity_events_event_type_enum" NOT NULL,
        "asset_id" character varying,
        "tx_hash" character varying,
        "event_timestamp" TIMESTAMP WITH TIME ZONE NOT NULL,
        "units" numeric(20,6) NOT NULL DEFAULT '1',
        "metadata" jsonb,
        "processed" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reward_activity_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_rae_epoch_id" ON "reward_activity_events" ("epoch_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_rae_wallet_address" ON "reward_activity_events" ("wallet_address")`);
    await queryRunner.query(`CREATE INDEX "IDX_rae_vault_id" ON "reward_activity_events" ("vault_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_rae_event_type" ON "reward_activity_events" ("event_type")`);
    await queryRunner.query(`CREATE INDEX "IDX_rae_processed" ON "reward_activity_events" ("processed")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_rae_epoch_wallet" ON "reward_activity_events" ("epoch_id", "wallet_address")`
    );

    // --- reward_activity_weights ---
    await queryRunner.query(`
      CREATE TABLE "reward_activity_weights" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "activity_type" "public"."reward_activity_weights_activity_type_enum" NOT NULL,
        "weight" numeric(10,4) NOT NULL DEFAULT '1',
        "description" text,
        "active" boolean NOT NULL DEFAULT true,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_raw_activity_type" UNIQUE ("activity_type"),
        CONSTRAINT "PK_reward_activity_weights" PRIMARY KEY ("id")
      )
    `);

    // --- reward_scores ---
    await queryRunner.query(`
      CREATE TABLE "reward_scores" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "epoch_id" uuid NOT NULL,
        "wallet_address" character varying NOT NULL,
        "activity_score" numeric(30,6) NOT NULL DEFAULT '0',
        "alignment_multiplier" numeric(4,2) NOT NULL DEFAULT '1',
        "base_reward" bigint NOT NULL DEFAULT 0,
        "final_reward" bigint NOT NULL DEFAULT 0,
        "was_capped" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_reward_scores_epoch_wallet" UNIQUE ("epoch_id", "wallet_address"),
        CONSTRAINT "PK_reward_scores" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_rs_epoch_id" ON "reward_scores" ("epoch_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_rs_wallet_address" ON "reward_scores" ("wallet_address")`);

    // --- reward_vesting_positions ---
    await queryRunner.query(`
      CREATE TABLE "reward_vesting_positions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "epoch_id" uuid NOT NULL,
        "wallet_address" character varying NOT NULL,
        "vault_id" uuid NOT NULL,
        "activity_type" "public"."reward_vesting_positions_activity_type_enum" NOT NULL,
        "total_amount" bigint NOT NULL,
        "immediate_amount" bigint NOT NULL,
        "vested_amount" bigint NOT NULL,
        "unlocked_amount" bigint NOT NULL DEFAULT 0,
        "required_vt_balance" bigint NOT NULL,
        "hold_factor" numeric(5,4) NOT NULL DEFAULT '0',
        "vesting_start" TIMESTAMP WITH TIME ZONE NOT NULL,
        "vesting_end" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" "public"."reward_vesting_positions_status_enum" NOT NULL DEFAULT 'active',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reward_vesting_positions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_rvp_epoch_id" ON "reward_vesting_positions" ("epoch_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_rvp_wallet_address" ON "reward_vesting_positions" ("wallet_address")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_rvp_wallet_vault" ON "reward_vesting_positions" ("wallet_address", "vault_id")`
    );

    // --- reward_balance_snapshots ---
    await queryRunner.query(`
      CREATE TABLE "reward_balance_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_address" character varying NOT NULL,
        "vault_id" uuid NOT NULL,
        "snapshot_date" date NOT NULL,
        "wallet_vt_balance" bigint NOT NULL DEFAULT 0,
        "lp_vt_equivalent" bigint NOT NULL DEFAULT 0,
        "effective_balance" bigint NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_rbs_wallet_vault_date" UNIQUE ("wallet_address", "vault_id", "snapshot_date"),
        CONSTRAINT "PK_reward_balance_snapshots" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_rbs_wallet_vault" ON "reward_balance_snapshots" ("wallet_address", "vault_id")`
    );
    await queryRunner.query(`CREATE INDEX "IDX_rbs_snapshot_date" ON "reward_balance_snapshots" ("snapshot_date")`);

    // --- reward_lp_positions ---
    await queryRunner.query(`
      CREATE TABLE "reward_lp_positions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "wallet_address" character varying NOT NULL,
        "vault_id" uuid NOT NULL,
        "pool_type" "public"."reward_lp_positions_pool_type_enum" NOT NULL,
        "dex" "public"."reward_lp_positions_dex_enum" NOT NULL,
        "lp_tokens" bigint NOT NULL DEFAULT 0,
        "vt_in_pool" bigint NOT NULL DEFAULT 0,
        "vt_user_equivalent" bigint NOT NULL DEFAULT 0,
        "position_age_seconds" integer NOT NULL DEFAULT 0,
        "first_detected" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_rlp_wallet_vault_pool_dex" UNIQUE ("wallet_address", "vault_id", "pool_type", "dex"),
        CONSTRAINT "PK_reward_lp_positions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_rlp_wallet_vault" ON "reward_lp_positions" ("wallet_address", "vault_id")`
    );
    await queryRunner.query(`CREATE INDEX "IDX_rlp_wallet" ON "reward_lp_positions" ("wallet_address")`);

    // --- reward_claims ---
    await queryRunner.query(`
      CREATE TABLE "reward_claims" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "epoch_id" uuid NOT NULL,
        "wallet_address" character varying NOT NULL,
        "reward_amount" bigint NOT NULL DEFAULT 0,
        "immediate_amount" bigint NOT NULL DEFAULT 0,
        "vested_amount" bigint NOT NULL DEFAULT 0,
        "status" "public"."reward_claims_status_enum" NOT NULL DEFAULT 'available',
        "claim_transaction_id" uuid,
        "claimed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_rc_epoch_wallet" UNIQUE ("epoch_id", "wallet_address"),
        CONSTRAINT "PK_reward_claims" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_rc_epoch_id" ON "reward_claims" ("epoch_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_rc_wallet_address" ON "reward_claims" ("wallet_address")`);
    await queryRunner.query(`CREATE INDEX "IDX_rc_claim_transaction_id" ON "reward_claims" ("claim_transaction_id")`);

    // --- Foreign keys ---
    await queryRunner.query(
      `ALTER TABLE "reward_activity_events" ADD CONSTRAINT "FK_rae_epoch" FOREIGN KEY ("epoch_id") REFERENCES "reward_epochs"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_activity_events" ADD CONSTRAINT "FK_rae_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_scores" ADD CONSTRAINT "FK_rs_epoch" FOREIGN KEY ("epoch_id") REFERENCES "reward_epochs"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_vesting_positions" ADD CONSTRAINT "FK_rvp_epoch" FOREIGN KEY ("epoch_id") REFERENCES "reward_epochs"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_vesting_positions" ADD CONSTRAINT "FK_rvp_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_balance_snapshots" ADD CONSTRAINT "FK_rbs_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_lp_positions" ADD CONSTRAINT "FK_rlp_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_claims" ADD CONSTRAINT "FK_rc_epoch" FOREIGN KEY ("epoch_id") REFERENCES "reward_epochs"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "reward_claims" ADD CONSTRAINT "FK_rc_claim_transaction" FOREIGN KEY ("claim_transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL`
    );

    // --- Add vault_weight to vaults ---
    await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_weight" numeric(10,4) NOT NULL DEFAULT '1'`);

    // --- Seed default activity weights ---
    await queryRunner.query(`
      INSERT INTO "reward_activity_weights" ("activity_type", "weight", "description") VALUES
      ('asset_contribution', 10, 'NFT/asset contribution to vault'),
      ('token_acquire', 5, 'Acquiring vault tokens'),
      ('acquire_phase_purchase', 5, 'Acquire phase participation bonus'),
      ('expansion_asset_contribution', 10, 'Expansion phase asset contribution'),
      ('expansion_token_purchase', 5, 'Expansion phase token purchase'),
      ('lp_position_update', 15, 'Providing liquidity in VT/ADA or VT/USDCx pools'),
      ('widget_swap', 2, 'Swaps via DexHunter widget'),
      ('governance_proposal', 50, 'Creating governance proposals'),
      ('governance_vote', 3, 'Voting on governance proposals')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop vault_weight from vaults
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_weight"`);

    // Drop foreign keys
    await queryRunner.query(`ALTER TABLE "reward_claims" DROP CONSTRAINT "FK_rc_claim_transaction"`);
    await queryRunner.query(`ALTER TABLE "reward_claims" DROP CONSTRAINT "FK_rc_epoch"`);
    await queryRunner.query(`ALTER TABLE "reward_lp_positions" DROP CONSTRAINT "FK_rlp_vault"`);
    await queryRunner.query(`ALTER TABLE "reward_balance_snapshots" DROP CONSTRAINT "FK_rbs_vault"`);
    await queryRunner.query(`ALTER TABLE "reward_vesting_positions" DROP CONSTRAINT "FK_rvp_vault"`);
    await queryRunner.query(`ALTER TABLE "reward_vesting_positions" DROP CONSTRAINT "FK_rvp_epoch"`);
    await queryRunner.query(`ALTER TABLE "reward_scores" DROP CONSTRAINT "FK_rs_epoch"`);
    await queryRunner.query(`ALTER TABLE "reward_activity_events" DROP CONSTRAINT "FK_rae_vault"`);
    await queryRunner.query(`ALTER TABLE "reward_activity_events" DROP CONSTRAINT "FK_rae_epoch"`);

    // Drop tables
    await queryRunner.query(`DROP TABLE "reward_claims"`);
    await queryRunner.query(`DROP TABLE "reward_lp_positions"`);
    await queryRunner.query(`DROP TABLE "reward_balance_snapshots"`);
    await queryRunner.query(`DROP TABLE "reward_vesting_positions"`);
    await queryRunner.query(`DROP TABLE "reward_scores"`);
    await queryRunner.query(`DROP TABLE "reward_activity_weights"`);
    await queryRunner.query(`DROP TABLE "reward_activity_events"`);
    await queryRunner.query(`DROP TABLE "reward_epochs"`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE "public"."reward_claims_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_lp_positions_dex_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_lp_positions_pool_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_vesting_positions_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_vesting_positions_activity_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_activity_weights_activity_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_activity_events_event_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."reward_epochs_status_enum"`);
  }
}
