import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAbstainVoteOption1758702222897 implements MigrationInterface {
  name = 'AddAbstainVoteOption1758702222897';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."vote_vote_enum" RENAME TO "vote_vote_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."vote_vote_enum" AS ENUM('yes', 'no', 'abstain')`);
    await queryRunner.query(
      `ALTER TABLE "vote" ALTER COLUMN "vote" TYPE "public"."vote_vote_enum" USING "vote"::"text"::"public"."vote_vote_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vote_vote_enum_old"`);
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
    await queryRunner.query(`CREATE TYPE "public"."vote_vote_enum_old" AS ENUM('yes', 'no')`);
    await queryRunner.query(
      `ALTER TABLE "vote" ALTER COLUMN "vote" TYPE "public"."vote_vote_enum_old" USING "vote"::"text"::"public"."vote_vote_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vote_vote_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vote_vote_enum_old" RENAME TO "vote_vote_enum"`);
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
