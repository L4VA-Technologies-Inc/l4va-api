import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateUserProfile1741864519191 implements MigrationInterface {
    name = 'UpdateUserProfile1741864519191'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "key"`);
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "url"`);
        await queryRunner.query(`ALTER TABLE "files" ADD "file_key" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "files" ADD "file_url" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "links" ADD "user_id" uuid`);
        await queryRunner.query(`ALTER TABLE "users" ADD "description" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "tvl" numeric(20,2) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "total_vaults" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "gains" numeric(10,2) NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "profile_image_id" uuid`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_96d6f1aafc327443850f263cd50" UNIQUE ("profile_image_id")`);
        await queryRunner.query(`ALTER TABLE "users" ADD "banner_image_id" uuid`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_657d44500fe38e604f4a6306620" UNIQUE ("banner_image_id")`);
        await queryRunner.query(`ALTER TABLE "links" ADD CONSTRAINT "FK_9f8dea86e48a7216c4f5369c1e4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_96d6f1aafc327443850f263cd50" FOREIGN KEY ("profile_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_657d44500fe38e604f4a6306620" FOREIGN KEY ("banner_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_657d44500fe38e604f4a6306620"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_96d6f1aafc327443850f263cd50"`);
        await queryRunner.query(`ALTER TABLE "links" DROP CONSTRAINT "FK_9f8dea86e48a7216c4f5369c1e4"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "UQ_657d44500fe38e604f4a6306620"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "banner_image_id"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "UQ_96d6f1aafc327443850f263cd50"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "profile_image_id"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "gains"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "total_vaults"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tvl"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "description"`);
        await queryRunner.query(`ALTER TABLE "links" DROP COLUMN "user_id"`);
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "file_url"`);
        await queryRunner.query(`ALTER TABLE "files" DROP COLUMN "file_key"`);
        await queryRunner.query(`ALTER TABLE "files" ADD "url" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "files" ADD "key" character varying NOT NULL`);
    }

}
