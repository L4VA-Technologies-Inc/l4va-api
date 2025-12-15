import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCustomPresets1765786593246 implements MigrationInterface {
  name = 'AddCustomPresets1765786593246';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."vault_preset_type_enum" AS ENUM('simple', 'contributors', 'acquirers', 'advanced', 'custom')`
    );

    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(
      `CREATE TABLE "vault_preset" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(120) NOT NULL, "type" "public"."vault_preset_type_enum" NOT NULL DEFAULT 'simple', "user_id" uuid, "config" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1bd2db06e9fb40d5445618aea05" PRIMARY KEY ("id"))`
    );

    await queryRunner.query(`
            INSERT INTO "vault_preset" ("name", "type", "config", "user_id")
            VALUES
            ('Simple', 'simple', '{"tokensForAcquires": 50, "acquireReserve": 80, "liquidityPoolContribution": 10, "creationThreshold": 1, "voteThreshold": 5, "executionThreshold": 51}'::jsonb, NULL),
            ('Contributors', 'contributors', '{"tokensForAcquires": 20, "acquireReserve": 80, "liquidityPoolContribution": 10, "creationThreshold": 1, "voteThreshold": 5, "executionThreshold": 51}'::jsonb, NULL),
            ('Acquirers', 'acquirers', '{"tokensForAcquires": 80, "acquireReserve": 80, "liquidityPoolContribution": 10, "creationThreshold": 1, "voteThreshold": 5, "executionThreshold": 51}'::jsonb, NULL),
            ('Advanced', 'advanced', '{}'::jsonb, NULL)
        `);

    await queryRunner.query(`ALTER TABLE "vaults" ADD "preset_id" uuid`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TABLE "vault_preset" ADD CONSTRAINT "FK_3f3eb3b35db1cf1a645222bddb8" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_0ccd6f2104f8def35d79037afd9" FOREIGN KEY ("preset_id") REFERENCES "vault_preset"("id") ON DELETE SET NULL ON UPDATE CASCADE`
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_0ccd6f2104f8def35d79037afd9"`);
    await queryRunner.query(`ALTER TABLE "vault_preset" DROP CONSTRAINT "FK_3f3eb3b35db1cf1a645222bddb8"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "preset_id"`);
    await queryRunner.query(`DROP TABLE "vault_preset"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );

    await queryRunner.query(`DROP TYPE "public"."vault_preset_type_enum"`);
  }
}
