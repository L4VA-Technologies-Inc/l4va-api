import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVaultTreasuryWalletsAndExtractedAssetStatus1764753150711 implements MigrationInterface {
  name = 'AddVaultTreasuryWalletsAndExtractedAssetStatus1764753150711';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(
      `CREATE TABLE "vault_treasury_wallets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vault_id" uuid NOT NULL, "treasury_address" character varying NOT NULL, "public_key_hash" character varying NOT NULL, "encrypted_private_key" bytea, "encryption_key_id" character varying NOT NULL, "metadata" jsonb NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6b42fabe7f2f96095c74a4703e6" UNIQUE ("vault_id"), CONSTRAINT "REL_6b42fabe7f2f96095c74a4703e" UNIQUE ("vault_id"), CONSTRAINT "PK_31f9d6beca9861e5ffa381d0d52" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum" RENAME TO "assets_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum" AS ENUM('pending', 'locked', 'released', 'distributed', 'extracted')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum" USING "status"::"text"::"public"."assets_status_enum"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "vault_treasury_wallets" ADD CONSTRAINT "FK_6b42fabe7f2f96095c74a4703e6" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "vault_treasury_wallets" DROP CONSTRAINT "FK_6b42fabe7f2f96095c74a4703e6"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum_old" AS ENUM('pending', 'locked', 'released', 'distributed')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum_old" USING "status"::"text"::"public"."assets_status_enum_old"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum_old" RENAME TO "assets_status_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`DROP TABLE "vault_treasury_wallets"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
