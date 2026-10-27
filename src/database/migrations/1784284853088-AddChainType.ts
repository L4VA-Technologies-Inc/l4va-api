import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChainType1784284853088 implements MigrationInterface {
  name = 'AddChainType1784284853088';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "chain_type" varchar NOT NULL DEFAULT 'cardano'`);
    await queryRunner.query(`ALTER TABLE "users" ADD "chain_type" varchar NOT NULL DEFAULT 'cardano'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "chain_type"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "chain_type"`);
  }
}
