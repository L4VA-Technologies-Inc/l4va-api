import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSnapshotChainTimepoint1789124294595 implements MigrationInterface {
  name = 'AddSnapshotChainTimepoint1789124294595';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "snapshot_block" bigint`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "snapshot_timepoint" bigint`);
    await queryRunner.query(
      `COMMENT ON COLUMN "snapshot"."snapshot_timepoint" IS 'EVM only: block.timestamp the balances correspond to. Passed to openDistribution as the pro-rata timepoint. Null on Cardano.'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "snapshot_timepoint"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "snapshot_block"`);
  }
}
