import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvmSupport1784539883155 implements MigrationInterface {
  name = 'AddEvmSupport1784539883155';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // -------------------------------------------------------------------------
    // vaults — numeric chain ID + on-chain EVM vault identifier
    // chain_id: 46630 for Robinhood testnet, 1 for Ethereum mainnet, null for Cardano rows
    // evm_vault_id: the bytes32 vaultId registered in VaultFactory (null for Cardano)
    // -------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "vaults" ADD "chain_id" bigint NULL`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "evm_vault_id" varchar NULL`);

    // -------------------------------------------------------------------------
    // transactions — EVM-specific fields (all nullable; Cardano rows stay null)
    // from_address : msg.sender / wallet that submitted the tx
    // to_address   : target contract or recipient
    // block_number : EVM block number (Cardano uses slot via tx_hash lookup)
    // chain_id     : numeric EVM chain ID — fast discriminator without a vault JOIN
    // log_index    : index of the event log within the block (for event-sourced records)
    // -------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "transactions" ADD "from_address" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "to_address" varchar NULL`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "block_number" bigint NULL`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "chain_id" bigint NULL`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "log_index" integer NULL`);

    // -------------------------------------------------------------------------
    // assets — numeric chain ID
    // policy_id reused as ERC-20/721/1155 contract address for EVM assets
    // asset_id  reused as tokenId (string) for ERC-721/1155; null for ERC-20/native
    // -------------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE "assets" ADD "chain_id" bigint NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "chain_id"`);

    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "log_index"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "chain_id"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "block_number"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "to_address"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "from_address"`);

    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "evm_vault_id"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "chain_id"`);
  }
}
