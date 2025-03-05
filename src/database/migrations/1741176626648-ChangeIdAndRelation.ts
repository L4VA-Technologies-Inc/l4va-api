import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeIdAndRelation1741176626648 implements MigrationInterface {
    name = 'ChangeIdAndRelation1741176626648'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2595182ac08342bf379e1b68657"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "users" ADD "id" uuid NOT NULL DEFAULT uuid_generate_v4()`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "PK_487a5346fa3693a430b6d6db60c"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "id" uuid NOT NULL DEFAULT uuid_generate_v4()`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "PK_487a5346fa3693a430b6d6db60c" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ownerId"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ownerId" uuid NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2595182ac08342bf379e1b68657" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2595182ac08342bf379e1b68657"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ownerId"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ownerId" integer NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "PK_487a5346fa3693a430b6d6db60c"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "id" SERIAL NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "PK_487a5346fa3693a430b6d6db60c" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "id"`);
        await queryRunner.query(`ALTER TABLE "users" ADD "id" SERIAL NOT NULL`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id")`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2595182ac08342bf379e1b68657" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
