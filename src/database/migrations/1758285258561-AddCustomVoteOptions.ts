import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCustomVoteOptions1758285258561 implements MigrationInterface {
  name = 'AddCustomVoteOptions1758285258561';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vote" RENAME COLUMN "vote" TO "vote_option_id"`);
    await queryRunner.query(`ALTER TYPE "public"."vote_vote_enum" RENAME TO "vote_vote_option_id_enum"`);
    await queryRunner.query(
      `CREATE TABLE "vote_options" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "proposal_id" uuid NOT NULL, "label" character varying NOT NULL, "order" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_b42c10f7972e40ae469e181739b" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`ALTER TABLE "proposal" ADD "has_custom_vote_options" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "vote_option_id"`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "vote_option_id" character varying NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "vote_options" ADD CONSTRAINT "FK_18dd8ab017bbcf7aac91e630aec" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
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
    await queryRunner.query(`ALTER TABLE "vote_options" DROP CONSTRAINT "FK_18dd8ab017bbcf7aac91e630aec"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "vote_option_id"`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "vote_option_id" "public"."vote_vote_option_id_enum" NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "has_custom_vote_options"`);
    await queryRunner.query(`DROP TABLE "vote_options"`);
    await queryRunner.query(`ALTER TYPE "public"."vote_vote_option_id_enum" RENAME TO "vote_vote_enum"`);
    await queryRunner.query(`ALTER TABLE "vote" RENAME COLUMN "vote_option_id" TO "vote"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
