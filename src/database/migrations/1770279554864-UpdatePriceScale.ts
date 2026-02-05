import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdatePriceScale1770279554864 implements MigrationInterface {
  name = 'UpdatePriceScale1770279554864';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TYPE "public"."vaults_failure_reason_enum" RENAME TO "vaults_failure_reason_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_failure_reason_enum" AS ENUM('asset_threshold_violation', 'acquire_threshold_not_met', 'no_contributions', 'no_confirmed_transactions', 'manual_cancellation', 'insufficient_lp_liquidity')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "failure_reason" TYPE "public"."vaults_failure_reason_enum" USING "failure_reason"::"text"::"public"."vaults_failure_reason_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_failure_reason_enum_old"`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "floor_price" TYPE numeric(20,10)`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "dex_price" TYPE numeric(20,15)`);
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
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "dex_price" TYPE numeric(20,2)`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "floor_price" TYPE numeric(20,2)`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_failure_reason_enum_old" AS ENUM('acquire_threshold_not_met', 'asset_threshold_violation', 'manual_cancellation', 'no_confirmed_transactions', 'no_contributions')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "failure_reason" TYPE "public"."vaults_failure_reason_enum_old" USING "failure_reason"::"text"::"public"."vaults_failure_reason_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_failure_reason_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."vaults_failure_reason_enum_old" RENAME TO "vaults_failure_reason_enum"`
    );
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
