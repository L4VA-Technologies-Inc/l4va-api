import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTerminationMetadata1768924534445 implements MigrationInterface {
  name = 'AddTerminationMetadata1768924534445';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "termination_metadata" jsonb`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum" RENAME TO "claims_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum" AS ENUM('lp', 'contributor', 'acquirer', 'l4va', 'final_distribution', 'cancellation', 'distribution', 'termination')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum" USING "type"::"text"::"public"."claims_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum" RENAME TO "vaults_vault_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum" AS ENUM('draft', 'created', 'published', 'contribution', 'acquire', 'investment', 'locked', 'failed', 'burned', 'govern', 'terminating')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum" USING "vault_status"::"text"::"public"."vaults_vault_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum_old"`);
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
      `CREATE TYPE "public"."vaults_vault_status_enum_old" AS ENUM('acquire', 'burned', 'contribution', 'created', 'draft', 'failed', 'govern', 'investment', 'locked', 'published')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum_old" USING "vault_status"::"text"::"public"."vaults_vault_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum_old" RENAME TO "vaults_vault_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum_old" AS ENUM('acquirer', 'cancellation', 'contributor', 'distribution', 'final_distribution', 'l4va', 'lp')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum_old" USING "type"::"text"::"public"."claims_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum_old" RENAME TO "claims_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "termination_metadata"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
