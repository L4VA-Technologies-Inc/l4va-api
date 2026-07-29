import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `claims.amount` and `claims.lovelace_amount` from `bigint` to
 * `numeric(78, 0)` so EVM VT / native amounts (18-decimal, up to ~10^24+)
 * can be stored directly without overflow.
 *
 * Cardano claims are unaffected: their values fit comfortably in `Number` for existing code paths.
 * For EVM-scale amounts, preserve precision by treating the numeric values as `string`/`bigint` (avoid `Number(...)`).
 */
export class UpdateClaimsAmountToNumeric1785321759809 implements MigrationInterface {
  name = 'UpdateClaimsAmountToNumeric1785321759809';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE claims
        ALTER COLUMN amount       TYPE numeric(78, 0) USING amount::numeric,
        ALTER COLUMN lovelace_amount TYPE numeric(78, 0) USING lovelace_amount::numeric
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // NOTE: values that exceed bigint range will cause this rollback to fail.
    // Truncate or delete EVM claims first if rolling back is required.
    await queryRunner.query(`
      ALTER TABLE claims
        ALTER COLUMN amount       TYPE bigint USING amount::bigint,
        ALTER COLUMN lovelace_amount TYPE bigint USING lovelace_amount::bigint
    `);
  }
}
