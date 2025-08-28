import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProposalTypeSpecificFields1756298606498 implements MigrationInterface {
  name = 'AddProposalTypeSpecificFields1756298606498';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "fungible_tokens" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "non_fungible_tokens" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "distribution_assets" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "termination_reason" text`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "termination_date" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "burn_assets" json`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
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
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "burn_assets"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "termination_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "termination_reason"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "distribution_assets"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "non_fungible_tokens"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "fungible_tokens"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
