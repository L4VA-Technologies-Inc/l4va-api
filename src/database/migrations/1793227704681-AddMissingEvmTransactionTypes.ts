import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TransactionType values that were added in code but never to the Postgres
 * enum, so inserting or filtering by them fails.
 */
const MISSING_TYPES = [
  'evm-sell-nft',
  'evm-release-nft-refundable',
  'evm-redeem-for',
  'evm-defer-termination-asset',
  'evm-resume-termination-asset',
  'evm-sweep-termination-remainder',
];

export class AddMissingEvmTransactionTypes1793227704681 implements MigrationInterface {
  name = 'AddMissingEvmTransactionTypes1793227704681';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const type of MISSING_TYPES) {
      await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS '${type}'`);
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop enum values; they stay defined but unused.
  }
}
