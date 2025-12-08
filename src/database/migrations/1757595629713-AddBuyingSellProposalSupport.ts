import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBuyingSellProposalSupport1757595629713 implements MigrationInterface {
  name = 'AddBuyingSellProposalSupport1757595629713';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "buying_selling_options" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "abstain" boolean`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell')`
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
      `CREATE TYPE "public"."proposal_proposal_type_enum_old" AS ENUM('staking', 'distribution', 'termination', 'burning')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum_old" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum_old" RENAME TO "proposal_proposal_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "abstain"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "buying_selling_options"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
