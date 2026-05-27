import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsExpandableAndAssetWhitelistProposalType1778752796390 implements MigrationInterface {
  name = 'AddIsExpandableAndAssetWhitelistProposalType1778752796390';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "is_expandable" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion', 'asset_whitelist_update')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Delete any proposals with the new proposal type before rolling back the enum
    await queryRunner.query(`DELETE FROM "proposal" WHERE "proposal_type" = 'asset_whitelist_update'`);
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum_old" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum_old" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum_old" RENAME TO "proposal_proposal_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "is_expandable"`);
  }
}
