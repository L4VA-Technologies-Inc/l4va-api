import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedAssetsStatus1748264767365 implements MigrationInterface {
    name = 'AddedAssetsStatus1748264767365'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`CREATE TYPE "public"."assets_origin_type_enum" AS ENUM('invested', 'contributed')`);
        await queryRunner.query(`ALTER TABLE "assets" ADD "origin_type" "public"."assets_origin_type_enum"`);
        await queryRunner.query(`COMMENT ON COLUMN "assets"."origin_type" IS 'Source or origin type of the asset (INVESTED, CONTRIBUTED)'`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`UPDATE assets SET origin_type = 'contributed';`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`COMMENT ON COLUMN "assets"."origin_type" IS 'Source or origin type of the asset (INVESTED, CONTRIBUTED)'`);
        await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "origin_type"`);
        await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
