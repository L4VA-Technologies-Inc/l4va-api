import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLpTokenDynamicValuationMethod1777551080183 implements MigrationInterface {
  name = 'AddLpTokenDynamicValuationMethod1777551080183';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets_whitelist" ADD "lp_pool_onchain_id" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "token_verifications" ADD "is_lp_token" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "token_verifications" ADD "lp_pool_onchain_id" text`);
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."amount" IS 'Smallest on-chain units (raw token amount locked in this box).'`
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."stake_tx_id" IS 'Transaction that created (or re-created after harvest/compound) this staking box.'`
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."unstake_tx_id" IS 'Transaction that closed this staking position.'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."unstake_tx_id" IS 'Reference to the transaction that closed this staking position'`
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."stake_tx_id" IS 'Reference to the transaction that created this staking position'`
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "token_staking_positions"."amount" IS 'Smallest on-chain units. Staked token amount.'`
    );
    await queryRunner.query(`ALTER TABLE "token_verifications" DROP COLUMN "lp_pool_onchain_id"`);
    await queryRunner.query(`ALTER TABLE "token_verifications" DROP COLUMN "is_lp_token"`);
    await queryRunner.query(`ALTER TABLE "assets_whitelist" DROP COLUMN "lp_pool_onchain_id"`);
  }
}
