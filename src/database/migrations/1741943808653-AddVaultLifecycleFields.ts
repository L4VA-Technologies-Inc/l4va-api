import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVaultLifecycleFields1741943808653 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add new columns for vault lifecycle management
    await queryRunner.query(`
      ALTER TABLE vaults
      ADD COLUMN IF NOT EXISTS contribution_phase_start timestamptz,
      ADD COLUMN IF NOT EXISTS investment_phase_start timestamptz,
      ADD COLUMN IF NOT EXISTS locked_at timestamptz;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove the columns in reverse order
    await queryRunner.query(`
      ALTER TABLE vaults
      DROP COLUMN IF EXISTS locked_at,
      DROP COLUMN IF EXISTS investment_phase_start,
      DROP COLUMN IF EXISTS contribution_phase_start;
    `);
  }
}
