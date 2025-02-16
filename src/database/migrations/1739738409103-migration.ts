import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1739738409103 implements MigrationInterface {
    name = 'Migration1739738409103'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" RENAME COLUMN "brief" TO "description"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" RENAME COLUMN "description" TO "brief"`);
    }

}
