import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V13 vaults pay a raise's acquirers on-chain (`claimOnchainAllocation`) instead of through the
 * allocation root. Their rows sit next to the Merkle leaves, flagged so they never enter a tree.
 */
export class AddEvmAllocationOnchain1795071782171 implements MigrationInterface {
  name = 'AddEvmAllocationOnchain1795071782171';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evm_allocations" ADD COLUMN IF NOT EXISTS "onchain" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_allocations" DROP COLUMN IF EXISTS "onchain"`);
  }
}
