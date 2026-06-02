import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAcquireOnlyLpAndTreasuryClaim1780397276849 implements MigrationInterface {
  name = 'AddAcquireOnlyLpAndTreasuryClaim1780397276849';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "claims" ADD "is_treasury_claim" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `COMMENT ON COLUMN "claims"."is_treasury_claim" IS 'If true, the ADA for this claim was routed to treasury. Assets linked to this claim should not be marked as DISTRIBUTED.'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "is_treasury_claim"`);
  }
}
