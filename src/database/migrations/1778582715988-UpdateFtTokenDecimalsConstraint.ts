import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateFtTokenDecimalsConstraint1778582715988 implements MigrationInterface {
  name = 'UpdateFtTokenDecimalsConstraint1778582715988';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the old CHECK constraint (0-9 range)
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT IF EXISTS "CHK_7c37c9750c104b1621f294a09e"`);

    // Add the new CHECK constraint (0-20 range)
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "CHK_7c37c9750c104b1621f294a09e" CHECK ("ft_token_decimals" BETWEEN 0 AND 20)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the new CHECK constraint (0-20 range)
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT IF EXISTS "CHK_7c37c9750c104b1621f294a09e"`);

    // Restore the old CHECK constraint (0-9 range)
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "CHK_7c37c9750c104b1621f294a09e" CHECK ("ft_token_decimals" BETWEEN 0 AND 9)`
    );
  }
}
