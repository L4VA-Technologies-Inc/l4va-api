import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStakingFieldsToAsset1783089338520 implements MigrationInterface {
  name = 'AddStakingFieldsToAsset1783089338520';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add STAKED to AssetStatus enum
    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum" RENAME TO "assets_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum" AS ENUM('pending', 'locked', 'released', 'distributed', 'extracted', 'listed', 'sold', 'burned', 'offered', 'cancel_offer', 'staked')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum" USING "status"::"text"::"public"."assets_status_enum"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum_old"`);

    // Add STAKING_REWARD to AssetOriginType enum
    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum" RENAME TO "assets_origin_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_origin_type_enum" AS ENUM('acquired', 'contributed', 'fee', 'bought', 'offered', 'staking_reward')`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum" USING "origin_type"::"text"::"public"."assets_origin_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum_old"`);

    // Add staking fields to assets table
    await queryRunner.query(`ALTER TABLE "assets" ADD "staking_platform" character varying`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "stake_id" bigint`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "stake_collection_id" integer`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "stake_tx_hash" character varying`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "unstake_tx_hash" character varying`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "staked_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "unstaked_at" TIMESTAMP WITH TIME ZONE`);

    // Add indexes for staking queries
    await queryRunner.query(
      `CREATE INDEX "IDX_assets_staking_platform" ON "assets" ("staking_platform") WHERE "staking_platform" IS NOT NULL`
    );
    await queryRunner.query(`CREATE INDEX "IDX_assets_stake_id" ON "assets" ("stake_id") WHERE "stake_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_status_staked" ON "assets" ("status") WHERE "status" = 'staked'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove indexes
    await queryRunner.query(`DROP INDEX "public"."IDX_assets_status_staked"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_assets_stake_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_assets_staking_platform"`);

    // Remove staking fields
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "unstaked_at"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "staked_at"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "unstake_tx_hash"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "stake_tx_hash"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "stake_collection_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "stake_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "staking_platform"`);

    // Revert AssetOriginType enum
    await queryRunner.query(
      `CREATE TYPE "public"."assets_origin_type_enum_old" AS ENUM('acquired', 'contributed', 'fee', 'bought', 'offered')`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum_old" USING "origin_type"::"text"::"public"."assets_origin_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum_old" RENAME TO "assets_origin_type_enum"`);

    // Revert AssetStatus enum
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum_old" AS ENUM('pending', 'locked', 'released', 'distributed', 'extracted', 'listed', 'sold', 'burned', 'offered', 'cancel_offer')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum_old" USING "status"::"text"::"public"."assets_status_enum_old"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum_old" RENAME TO "assets_status_enum"`);
  }
}
