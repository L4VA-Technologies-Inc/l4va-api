import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateTagsAndProposalTypes1757938122146 implements MigrationInterface {
  name = 'UpdateTagsAndProposalTypes1757938122146';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."proposal_status_enum" RENAME TO "proposal_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_status_enum" AS ENUM('upcoming', 'active', 'passed', 'rejected', 'executed')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "status" TYPE "public"."proposal_status_enum" USING "status"::"text"::"public"."proposal_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum_old"`);
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
      `CREATE TYPE "public"."proposal_status_enum_old" AS ENUM('upcomming', 'active', 'passed', 'rejected', 'executed')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "status" TYPE "public"."proposal_status_enum_old" USING "status"::"text"::"public"."proposal_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."proposal_status_enum_old" RENAME TO "proposal_status_enum"`);
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
