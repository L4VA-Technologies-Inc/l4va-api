import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAssetMetadataColumns1765181788192 implements MigrationInterface {
  name = 'AddAssetMetadataColumns1765181788192';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);

    // Add new columns
    await queryRunner.query(`ALTER TABLE "assets" ADD "image" text`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "decimals" integer`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "name" text`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "description" text`);

    // Migrate data from metadata JSONB to dedicated columns
    await queryRunner.query(`
      UPDATE "assets"
      SET 
        "image" = COALESCE(
          metadata->>'image',
          metadata->'files'->0->>'src'
        ),
        "decimals" = CASE 
          WHEN metadata->>'decimals' IS NOT NULL 
          THEN (metadata->>'decimals')::integer 
          ELSE NULL 
        END,
        "name" = metadata->'onchainMetadata'->>'name',
        "description" = metadata->'onchainMetadata'->>'description'
      WHERE metadata IS NOT NULL
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
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "description"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "name"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "decimals"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "image"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
