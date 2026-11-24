import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persisted progress of the Uniswap v4 position scan per pool, so an API restart resumes the
 * `ModifyLiquidity` log scan instead of reading the pool's whole history again.
 */
export class AddEvmV4PositionScans1795507317830 implements MigrationInterface {
  name = 'AddEvmV4PositionScans1795507317830';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "evm_v4_position_scans" (
        "pool_id" varchar(66) NOT NULL,
        "position_manager" varchar(42) NOT NULL,
        "start_block" numeric(30,0) NOT NULL,
        "next_block" numeric(30,0) NOT NULL,
        "token_ids" text[] NOT NULL DEFAULT '{}',
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_evm_v4_position_scans" PRIMARY KEY ("pool_id", "position_manager")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_v4_position_scans"`);
  }
}
