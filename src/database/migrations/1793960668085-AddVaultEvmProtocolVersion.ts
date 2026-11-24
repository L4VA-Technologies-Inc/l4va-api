import { MigrationInterface, QueryRunner } from 'typeorm';

/** Robinhood vaults: the protocol version (address set) a vault is pinned to. Null on Cardano. */
export class AddVaultEvmProtocolVersion1793960668085 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD COLUMN IF NOT EXISTS "evm_protocol_version" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "evm_protocol_version"`);
  }
}
