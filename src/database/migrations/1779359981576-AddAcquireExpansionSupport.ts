import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAcquireExpansionSupport1779359981576 implements MigrationInterface {
  name = 'AddAcquireExpansionSupport1779359981576';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add allow_acquire_expansion column to vaults table
    await queryRunner.query(`ALTER TABLE "vaults" ADD "allow_acquire_expansion" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `COMMENT ON COLUMN "vaults"."allow_acquire_expansion" IS 'If true, vault allows governance proposals for acquire expansion (ADA → VT minting).'`
    );

    // Update proposal_type enum to include acquire_expansion
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action', 'expansion', 'acquire_expansion')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse enum change
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

    // Remove allow_acquire_expansion column
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "allow_acquire_expansion"`);
  }
}
