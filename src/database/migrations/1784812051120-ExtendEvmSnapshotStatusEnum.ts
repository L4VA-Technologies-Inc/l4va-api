import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extend evm_snapshot_status_enum with two states that make the close-cycle
 * pipeline crash-safe and reconcilable:
 *
 *   submitting            — writeContract issued but the tx hash is not yet
 *                           persisted. Only lives inside a single call frame
 *                           to prevent concurrent broadcasts of the same
 *                           snapshot when the atomic UPDATE gate is used.
 *   reconciliation_required — the receipt was successful BUT the emitted
 *                           events either did not appear or didn't match the
 *                           prepared snapshot. The tx hash is stored; a
 *                           reconciliation routine re-reads the on-chain
 *                           cycle to decide whether to promote to `confirmed`
 *                           or mark `failed`.
 *
 * Note: Postgres ALTER TYPE ... ADD VALUE requires being run outside of a
 * transaction block. TypeORM's default migration executor already runs each
 * migration statement in its own txn, so IF NOT EXISTS is enough here.
 */
export class ExtendEvmSnapshotStatusEnum1784812051120 implements MigrationInterface {
  name = 'ExtendEvmSnapshotStatusEnum1784812051120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "evm_snapshot_status_enum" ADD VALUE IF NOT EXISTS 'submitting'`);
    await queryRunner.query(`ALTER TYPE "evm_snapshot_status_enum" ADD VALUE IF NOT EXISTS 'reconciliation_required'`);
  }

  public async down(): Promise<void> {
    // Postgres does not support DROP VALUE from an enum. Leaving the added
    // values in place on downgrade is safe — they simply become unused.
  }
}
