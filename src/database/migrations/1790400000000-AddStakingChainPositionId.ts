import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStakingChainPositionId1790400000000 implements MigrationInterface {
  name = 'AddStakingChainPositionId1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "token_staking_positions" ADD "chain_position_id" character varying`);
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."chain_position_id" IS 'EVM only: L4VAStaking position id. Null for Cardano boxes.'`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_token_staking_positions_chain_position_id" ON "token_staking_positions" ("chain_position_id") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_token_staking_positions_chain_position_id"`);
    await queryRunner.query(`ALTER TABLE "token_staking_positions" DROP COLUMN "chain_position_id"`);
  }
}
