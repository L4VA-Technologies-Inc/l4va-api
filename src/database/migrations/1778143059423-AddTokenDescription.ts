import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenDescription1778143059423 implements MigrationInterface {
  name = 'AddTokenDescription1778143059423';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "token_description" character varying`);
    await queryRunner.query(`UPDATE "vaults" SET "token_description" = "description" WHERE "description" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "token_description"`);
  }
}
