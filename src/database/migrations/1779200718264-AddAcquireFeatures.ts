import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAcquireFeatures1779200718264 implements MigrationInterface {
  name = 'AddAcquireFeatures1779200718264';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add acquire-only vault support columns
    await queryRunner.query(`ALTER TABLE "vaults" ADD "is_acquire_only" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."is_acquire_only" IS 'If true, vault skips contribution phase and goes directly to acquire phase.'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "min_acquire_threshold" bigint`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."min_acquire_threshold" IS 'Minimum ADA (in lovelace) that must be acquired for the vault to lock. Only used for acquire-only vaults.'`
    );

    // Add acquire expansion support column
    await queryRunner.query(`ALTER TABLE "vaults" ADD "allow_acquire_expansion" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."allow_acquire_expansion" IS 'If true, vault allows governance proposals for acquire expansion (ADA → VT minting).'`
    );

    // Update vault_preset_type_enum to include acquire_only
    await queryRunner.query(`ALTER TYPE "public"."vault_preset_type_enum" RENAME TO "vault_preset_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum" AS ENUM('simple', 'contributors', 'acquirers', 'acquirers_50', 'advanced', 'custom', 'acquire_only')`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_preset" ALTER COLUMN "type" TYPE "public"."vault_preset_type_enum" USING "type"::"text"::"public"."vault_preset_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" SET DEFAULT 'simple'`);
    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum_old"`);

    // Update proposal_type enum to include acquire_expansion
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion', 'acquire_expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum_old"`);

    // Insert the acquire_only preset
    await queryRunner.query(`
      INSERT INTO "vault_preset" ("id", "name", "type", "config", "is_active", "created_at", "updated_at") VALUES
      (
        'f7e8d9c0-1234-5678-90ab-cdef12345678',
        'Acquire Only',
        'acquire_only',
        '{"voteThreshold": 5, "acquireReserve": 100, "creationThreshold": 1, "tokensForAcquires": 100, "executionThreshold": 51, "liquidityPoolContribution": 0}',
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      ) ON CONFLICT ("id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove acquire_only preset
    await queryRunner.query(`DELETE FROM "vault_preset" WHERE "type" = 'acquire_only'`);

    // Reverse proposal_type enum change
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum_old" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum_old" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum_old" RENAME TO "proposal_proposal_type_enum"`
    );

    // Reverse vault_preset_type_enum change
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum_old" AS ENUM('simple', 'contributors', 'acquirers', 'acquirers_50', 'advanced', 'custom')`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_preset" ALTER COLUMN "type" TYPE "public"."vault_preset_type_enum_old" USING "type"::"text"::"public"."vault_preset_type_enum_old"`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" SET DEFAULT 'simple'`);
    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vault_preset_type_enum_old" RENAME TO "vault_preset_type_enum"`);

    // Remove acquire columns
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "allow_acquire_expansion"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "min_acquire_threshold"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "is_acquire_only"`);
  }
}
