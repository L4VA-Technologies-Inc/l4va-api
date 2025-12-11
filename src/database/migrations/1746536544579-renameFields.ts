import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameFields1746536544579 implements MigrationInterface {
  name = 'RenameFields1746536544579';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "acquirer_whitelist" DROP CONSTRAINT "FK_4996e41bd51ba848c8f6ac22a03"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "valuation_type"`);
    await queryRunner.query(`DROP TYPE "public"."vaults_valuation_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "off_assets_offered"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_token_ticker"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_acquire_reserve"`);
    await queryRunner.query(`CREATE TYPE "public"."vaults_value_method_enum" AS ENUM('lbe', 'fixed')`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "value_method" "public"."vaults_value_method_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "tokens_for_acquires" numeric`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquire_reserve" numeric`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_token_ticker" character varying`);
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_token_ticker"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_reserve"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "tokens_for_acquires"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "value_method"`);
    await queryRunner.query(`DROP TYPE "public"."vaults_value_method_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_acquire_reserve" numeric`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_token_ticker" character varying`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "off_assets_offered" numeric`);
    await queryRunner.query(`CREATE TYPE "public"."vaults_valuation_type_enum" AS ENUM('lbe', 'fixed')`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "valuation_type" "public"."vaults_valuation_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "acquirer_whitelist" ADD CONSTRAINT "FK_4996e41bd51ba848c8f6ac22a03" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }
}
