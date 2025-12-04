import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateClaimsMetadataToColumns1765778339943 implements MigrationInterface {
  name = 'MigrateClaimsMetadataToColumns1765778339943';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);

    // Migrate adaAmount from metadata to lovelace_amount column
    // Handle both integer (already in lovelaces) and decimal (in ADA) values
    await queryRunner.query(`
      UPDATE "claims"
      SET "lovelace_amount" = 
        CASE 
          WHEN (metadata->>'adaAmount')::numeric >= 1000000 THEN (metadata->>'adaAmount')::bigint
          ELSE ((metadata->>'adaAmount')::numeric * 1000000)::bigint
        END
      WHERE metadata->>'adaAmount' IS NOT NULL
        AND "lovelace_amount" IS NULL
    `);

    // Migrate multiplier from metadata to multiplier column
    await queryRunner.query(`
      UPDATE "claims"
      SET "multiplier" = CAST(metadata->>'multiplier' AS NUMERIC)
      WHERE metadata->>'multiplier' IS NOT NULL
        AND "multiplier" IS NULL
    `);

    // Optional: Remove migrated fields from metadata to clean up
    await queryRunner.query(`
      UPDATE "claims"
      SET metadata = metadata - 'adaAmount' - 'multiplier'
      WHERE metadata ? 'adaAmount' OR metadata ? 'multiplier'
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

    // Restore data from columns back to metadata (for rollback)
    await queryRunner.query(`
      UPDATE "claims"
      SET metadata = COALESCE(metadata, '{}'::jsonb) || 
        CASE 
          WHEN "lovelace_amount" IS NOT NULL THEN jsonb_build_object('adaAmount', "lovelace_amount")
          ELSE '{}'::jsonb
        END ||
        CASE 
          WHEN "multiplier" IS NOT NULL THEN jsonb_build_object('multiplier', "multiplier")
          ELSE '{}'::jsonb
        END
      WHERE "lovelace_amount" IS NOT NULL OR "multiplier" IS NOT NULL
    `);

    // Clear the columns after restoring to metadata
    await queryRunner.query(`
      UPDATE "claims"
      SET "lovelace_amount" = NULL, "multiplier" = NULL
      WHERE metadata->>'adaAmount' IS NOT NULL OR metadata->>'multiplier' IS NOT NULL
    `);

    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
