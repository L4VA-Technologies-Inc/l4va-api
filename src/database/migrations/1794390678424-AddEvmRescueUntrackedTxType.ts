import { MigrationInterface, QueryRunner } from 'typeorm';

/** Transaction type for admin-signed `rescueUntracked*` on post-V10-deployer vaults. */
export class AddEvmRescueUntrackedTxType1794390678424 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-rescue-untracked'`
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value; rows of this type are harmless if left behind.
  }
}
