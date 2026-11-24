import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persist planner omissions so completed-but-partial rebalances remain explainable. */
export class AddIndexRebalanceSkippedLegs1794131481820 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_index_rebalances" ADD COLUMN IF NOT EXISTS "skipped_legs" jsonb NOT NULL DEFAULT '[]'::jsonb`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_index_rebalances" DROP COLUMN IF EXISTS "skipped_legs"`);
  }
}
