import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedFileAndAssetWihitelistEntity1741254059494 implements MigrationInterface {
    name = 'AddedFileAndAssetWihitelistEntity1741254059494'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying NOT NULL, "url" character varying NOT NULL, "file_type" character varying NOT NULL, "metadata" jsonb, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "assets_whitelist" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "asset_id" character varying NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vaultId" uuid, CONSTRAINT "PK_85cf89e7248c7f3f4013e524c84" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "createdAt"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "imageUrl"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "bannerUrl"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "createdAt"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "updatedAt"`);
        await queryRunner.query(`ALTER TABLE "users" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "users" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "vaultImageId" uuid`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "UQ_2abd376a23e75271cb52cebbd98" UNIQUE ("vaultImageId")`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "bannerImageId" uuid`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "UQ_7c28507516704086b715221fdb5" UNIQUE ("bannerImageId")`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2595182ac08342bf379e1b68657"`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ownerId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "assets_whitelist" ADD CONSTRAINT "FK_f985e605f0163582ba9add0540f" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2595182ac08342bf379e1b68657" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2abd376a23e75271cb52cebbd98" FOREIGN KEY ("vaultImageId") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_7c28507516704086b715221fdb5" FOREIGN KEY ("bannerImageId") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_7c28507516704086b715221fdb5"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2abd376a23e75271cb52cebbd98"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2595182ac08342bf379e1b68657"`);
        await queryRunner.query(`ALTER TABLE "assets_whitelist" DROP CONSTRAINT "FK_f985e605f0163582ba9add0540f"`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ownerId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2595182ac08342bf379e1b68657" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "UQ_7c28507516704086b715221fdb5"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "bannerImageId"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "UQ_2abd376a23e75271cb52cebbd98"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vaultImageId"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "updated_at"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "created_at"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "bannerUrl" character varying`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "imageUrl" character varying`);
        await queryRunner.query(`ALTER TABLE "users" ADD "updatedAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`ALTER TABLE "users" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
        await queryRunner.query(`DROP TABLE "assets_whitelist"`);
        await queryRunner.query(`DROP TABLE "files"`);
    }

}
