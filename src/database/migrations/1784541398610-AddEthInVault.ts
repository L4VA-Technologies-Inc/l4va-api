import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEthInVault1784541398610 implements MigrationInterface {
  name = 'AddEthInVault1784541398610';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "total_assets_cost_eth" numeric DEFAULT '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "total_assets_cost_eth"`);
  }
}
