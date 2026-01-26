import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewPresetType1769424678718 implements MigrationInterface {
  name = 'AddNewPresetType1769424678718';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TYPE "public"."vault_preset_type_enum" RENAME TO "vault_preset_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum" AS ENUM('simple', 'contributors', 'acquirers', 'acquirers_50', 'advanced', 'custom')`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_preset" ALTER COLUMN "type" TYPE "public"."vault_preset_type_enum" USING "type"::"text"::"public"."vault_preset_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" SET DEFAULT 'simple'`);
    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum_old"`);

    await queryRunner.query(`DELETE FROM "vault_preset" WHERE "type" != 'custom'`);

    await queryRunner.query(`
      INSERT INTO "vault_preset" ("id", "name", "type", "config", "created_at", "updated_at") VALUES
      ('aa1aa139-1fb9-466c-b048-5cc1ba5fe298', 'Advanced', 'advanced', '{}', '2025-12-15 08:33:36.530', '2025-12-15 08:33:36.530'),
      ('a54d78b8-29ea-489c-a670-e19494c43290', 'Asset Contributors Only', 'simple', '{"voteThreshold": 5, "acquireReserve": 100, "creationThreshold": 1, "tokensForAcquires": 0, "executionThreshold": 51, "liquidityPoolContribution": 0}', '2025-12-15 08:33:36.530', '2025-12-15 08:33:36.530'),
      ('8054572e-3f68-4981-9e38-53433242d4c0', 'Asset Contributors Only + LP', 'contributors', '{"voteThreshold": 5, "acquireReserve": 100, "creationThreshold": 1, "tokensForAcquires": 0, "executionThreshold": 51, "liquidityPoolContribution": 10}', '2025-12-15 08:33:36.530', '2025-12-15 08:33:36.530'),
      ('ed6c391a-e84f-4e3b-b4d6-57a2b114a899', '100% of Assets Fractionalized for Acquirers', 'acquirers', '{"voteThreshold": 5, "acquireReserve": 100, "creationThreshold": 1, "tokensForAcquires": 100, "executionThreshold": 51, "liquidityPoolContribution": 10}', '2025-12-15 08:33:36.530', '2025-12-15 08:33:36.530'),
      ('4d5ea2de-6773-454d-9cc5-ca3ad5c8bab1', '50% of Assets Fractionalized for Acquirers', 'acquirers_50', '{"voteThreshold": 5, "acquireReserve": 100, "creationThreshold": 1, "tokensForAcquires": 50, "executionThreshold": 51, "liquidityPoolContribution": 10}', '2026-01-26 10:46:25.118', '2026-01-26 10:46:25.118')
    `);

    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum_old" AS ENUM('acquirers', 'advanced', 'contributors', 'custom', 'simple')`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_preset" ALTER COLUMN "type" TYPE "public"."vault_preset_type_enum_old" USING "type"::"text"::"public"."vault_preset_type_enum_old"`
    );
    await queryRunner.query(`ALTER TABLE "vault_preset" ALTER COLUMN "type" SET DEFAULT 'simple'`);
    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vault_preset_type_enum_old" RENAME TO "vault_preset_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
