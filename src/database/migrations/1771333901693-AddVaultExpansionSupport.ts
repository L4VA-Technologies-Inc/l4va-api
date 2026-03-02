import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVaultExpansionSupport1771333901693 implements MigrationInterface {
  name = 'AddVaultExpansionSupport1771333901693';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "expansion_phase_start" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "expansion_duration" bigint`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum" RENAME TO "vaults_vault_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum" AS ENUM('draft', 'created', 'published', 'contribution', 'acquire', 'investment', 'locked', 'failed', 'burned', 'govern', 'terminating', 'expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum" USING "vault_status"::"text"::"public"."vaults_vault_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum_old"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum" RENAME TO "claims_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum" AS ENUM('lp', 'contributor', 'acquirer', 'l4va', 'final_distribution', 'cancellation', 'distribution', 'termination', 'expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum" USING "type"::"text"::"public"."claims_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum_old"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum_old"`);
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
      `CREATE TYPE "public"."proposal_proposal_type_enum_old" AS ENUM('burning', 'buy_sell', 'distribution', 'marketplace_action', 'staking', 'termination')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum_old" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum_old" RENAME TO "proposal_proposal_type_enum"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum_old" AS ENUM('acquirer', 'cancellation', 'contributor', 'distribution', 'final_distribution', 'l4va', 'lp', 'termination')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum_old" USING "type"::"text"::"public"."claims_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum_old" RENAME TO "claims_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum_old" AS ENUM('acquire', 'burned', 'contribution', 'created', 'draft', 'failed', 'govern', 'investment', 'locked', 'published', 'terminating')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum_old" USING "vault_status"::"text"::"public"."vaults_vault_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum_old" RENAME TO "vaults_vault_status_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "expansion_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "expansion_phase_start"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
