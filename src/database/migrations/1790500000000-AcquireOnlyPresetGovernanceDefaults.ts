import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch governance defaults for acquire-only vaults: proposal threshold 0.1%,
 * quorum 33%, approval 51%. The preset config is copied into every new vault,
 * so it overrides the form's own defaults.
 */
export class AcquireOnlyPresetGovernanceDefaults1790500000000 implements MigrationInterface {
  name = 'AcquireOnlyPresetGovernanceDefaults1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "vault_preset"
      SET "config" = "config" || '{"creationThreshold": 0.1, "cosigningThreshold": 33, "executionThreshold": 51}'::jsonb,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "type" = 'acquire_only' AND "user_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "vault_preset"
      SET "config" = "config" || '{"creationThreshold": 1, "cosigningThreshold": 35, "executionThreshold": 51}'::jsonb,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "type" = 'acquire_only' AND "user_id" IS NULL
    `);
  }
}
