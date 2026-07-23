import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the block number the AllocationClaimed event was emitted in on the
 * per-leaf row. Combined with the tx hash this pins the claim to a specific
 * on-chain moment for audit / reorg reasoning.
 */
export class AddClaimBlockNumberToEvmAllocations1784814704081 implements MigrationInterface {
  name = 'AddClaimBlockNumberToEvmAllocations1784814704081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "evm_allocations"
        ADD COLUMN IF NOT EXISTS "claim_block_number" bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_allocations" DROP COLUMN IF EXISTS "claim_block_number"`);
  }
}
