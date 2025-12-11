import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPresetsForVaults1765365691197 implements MigrationInterface {
  name = 'AddPresetsForVaults1765365691197';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum" AS ENUM('simple', 'contributors', 'acquirers', 'advanced', 'custom')`
    );
    await queryRunner.query(
      `CREATE TABLE "vault_preset" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(120) NOT NULL, "type" "public"."vault_preset_type_enum" NOT NULL DEFAULT 'simple', "user_id" uuid, "config" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1bd2db06e9fb40d5445618aea05" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "preset_id" uuid`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "created_at"`);
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`
    );
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "start_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "start_date" TIMESTAMP WITH TIME ZONE NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "end_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "end_date" TIMESTAMP WITH TIME ZONE NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "execution_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "execution_date" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "termination_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "termination_date" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "timestamp"`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
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
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "timestamp"`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "timestamp" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "termination_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "termination_date" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "execution_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "execution_date" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "end_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "end_date" TIMESTAMP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "start_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "start_date" TIMESTAMP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "preset_id"`);
    await queryRunner.query(`DROP TABLE "vault_preset"`);
    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
