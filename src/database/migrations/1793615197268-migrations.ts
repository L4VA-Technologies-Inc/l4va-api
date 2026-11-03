import { MigrationInterface, QueryRunner } from 'typeorm';

/** EVM snapshots: VT held in Uniswap positions, attributed to the position owner for voting. */
export class Migrations1793615197268 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "snapshot" ADD COLUMN IF NOT EXISTS "lp_balances" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN IF EXISTS "lp_balances"`);
  }
}
