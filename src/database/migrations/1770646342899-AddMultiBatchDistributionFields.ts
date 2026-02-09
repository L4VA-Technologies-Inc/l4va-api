import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMultiBatchDistributionFields1770646342899 implements MigrationInterface {
  name = 'AddMultiBatchDistributionFields1770646342899';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "current_distribution_batch" smallint`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."current_distribution_batch" IS 'Current batch number being processed (1-based)'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "total_distribution_batches" smallint`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."total_distribution_batches" IS 'Total number of distribution batches needed'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "pending_multipliers" jsonb DEFAULT null`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."pending_multipliers" IS 'Multipliers not yet sent on-chain (remaining batches)'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "pending_ada_distribution" jsonb DEFAULT null`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."pending_ada_distribution" IS 'ADA distribution not yet sent on-chain (remaining batches)'`
    );
    await queryRunner.query(`ALTER TABLE "claims" ADD "distribution_batch" smallint`);
    await queryRunner.query(
      `COMMENT ON COLUMN "claims"."distribution_batch" IS 'Which batch this claim belongs to for multi-batch distribution (1, 2, 3...)'`
    );
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
      `COMMENT ON COLUMN "claims"."distribution_batch" IS 'Which batch this claim belongs to for multi-batch distribution (1, 2, 3...)'`
    );
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "distribution_batch"`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."pending_ada_distribution" IS 'ADA distribution not yet sent on-chain (remaining batches)'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "pending_ada_distribution"`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."pending_multipliers" IS 'Multipliers not yet sent on-chain (remaining batches)'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "pending_multipliers"`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."total_distribution_batches" IS 'Total number of distribution batches needed'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "total_distribution_batches"`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."current_distribution_batch" IS 'Current batch number being processed (1-based)'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "current_distribution_batch"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
