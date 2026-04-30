import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLpTokenDynamicValuationMethod1777551080183 implements MigrationInterface {
  name = 'AddLpTokenDynamicValuationMethod1777551080183';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets_whitelist" ADD "lp_pool_onchain_id" text`);
    await queryRunner.query(`ALTER TABLE "token_verifications" ADD "is_lp_token" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "token_verifications" ADD "lp_pool_onchain_id" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "token_verifications" DROP COLUMN "lp_pool_onchain_id"`);
    await queryRunner.query(`ALTER TABLE "token_verifications" DROP COLUMN "is_lp_token"`);
    await queryRunner.query(`ALTER TABLE "assets_whitelist" DROP COLUMN "lp_pool_onchain_id"`);
  }
}
