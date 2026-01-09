import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMarket1767879411325 implements MigrationInterface {
  name = 'AddMarket1767879411325';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(
      `CREATE TABLE "markets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "unit" character varying(255) NOT NULL, "circSupply" numeric(20,8) NOT NULL DEFAULT '0', "fdv" numeric(20,8) NOT NULL DEFAULT '0', "mcap" numeric(20,8) NOT NULL DEFAULT '0', "price" numeric(20,8) NOT NULL DEFAULT '0', "ticker" character varying(50) NOT NULL, "totalSupply" numeric(20,8) NOT NULL DEFAULT '0', "1h" numeric(10,6) NOT NULL DEFAULT '0', "24h" numeric(10,6) NOT NULL DEFAULT '0', "7d" numeric(10,6) NOT NULL DEFAULT '0', "30d" numeric(10,6) NOT NULL DEFAULT '0', "image" character varying(500), "tvl" numeric(20,8) NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_2a6f8f3ed564d1ead55bd28817c" UNIQUE ("unit"), CONSTRAINT "PK_dda44129b32f21ae9f1c28dcf99" PRIMARY KEY ("id"))`
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
    await queryRunner.query(`DROP TABLE "markets"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
