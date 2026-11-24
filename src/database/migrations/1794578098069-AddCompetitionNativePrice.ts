import { MigrationInterface, QueryRunner } from 'typeorm';

/** Creator Challenge: store token prices in ETH so token returns don't track ETH/USD. */
export class AddCompetitionNativePrice1794578098069 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "competition_entries" ADD COLUMN IF NOT EXISTS "entry_price_native" numeric`);
    await queryRunner.query(`ALTER TABLE "competition_snapshots" ADD COLUMN IF NOT EXISTS "price_native" numeric`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "competition_snapshots" DROP COLUMN "price_native"`);
    await queryRunner.query(`ALTER TABLE "competition_entries" DROP COLUMN "entry_price_native"`);
  }
}
