import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateAssetTypesFromCntToAdaAndFt1756460610514 implements MigrationInterface {
  name = 'UpdateAssetTypesFromCntToAdaAndFt1756460610514';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);

    // Step 2: Create a new enum type that includes both old and new values
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum" RENAME TO "assets_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum" AS ENUM('nft', 'cnt', 'ft', 'ada')`);

    // Step 3: Update the column to use the transitional enum
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum" USING "type"::"text"::"public"."assets_type_enum"`
    );

    // Step 4: Update 'cnt' values to 'ada' or 'ft'
    await queryRunner.query(`UPDATE "assets" SET "type" = 'ada' WHERE "type" = 'cnt'`);

    // Step 5: Create the final enum without 'cnt'
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum" RENAME TO "assets_type_enum_transitional"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum" AS ENUM('nft', 'ft', 'ada')`);

    // Step 6: Update the column to use the final enum
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum" USING "type"::"text"::"public"."assets_type_enum"`
    );

    // Step 7: Clean up the temporary enum
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum_old"`);
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum_transitional"`);

    // Rest of your migration
    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum" RENAME TO "assets_origin_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_origin_type_enum" AS ENUM('acquired', 'contributed')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum" USING "origin_type"::"text"::"public"."assets_origin_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum_old"`);

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
    await queryRunner.query(
      `CREATE TYPE "public"."assets_origin_type_enum_old" AS ENUM('invested', 'acquired', 'contributed')`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum_old" USING "origin_type"::"text"::"public"."assets_origin_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum_old" RENAME TO "assets_origin_type_enum"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum_old" AS ENUM('nft', 'cnt')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum_old" USING "type"::"text"::"public"."assets_type_enum_old"`
    );
    await queryRunner.query(`UPDATE "assets" SET "type" = 'cnt' WHERE "type" = 'ada' OR "type" = 'ft'`);

    await queryRunner.query(`DROP TYPE "public"."assets_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum_old" RENAME TO "assets_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
