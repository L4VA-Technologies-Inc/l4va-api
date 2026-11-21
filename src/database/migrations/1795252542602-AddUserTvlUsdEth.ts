import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Robinhood profile TVL in native ETH, summed from each vault's own ETH value. Deriving it from
 * the ADA `tvl` made Robinhood profiles move with the ADA price. USD is derived from it on read.
 * Filled by the next vault valuation run.
 */
export class AddUserTvlUsdEth1795252542602 implements MigrationInterface {
  name = 'AddUserTvlUsdEth1795252542602';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tvl_eth" numeric(30,8) NOT NULL DEFAULT 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "tvl_eth"`);
  }
}
