import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvmGovernanceTransactionsAndExternalPositions1785938643414 implements MigrationInterface {
  name = 'AddEvmGovernanceTransactionsAndExternalPositions1785938643414';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-open-cycle'`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-open-position'`);
    // CLOSE_POSITION proposal action is persisted as this transaction type.
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-close-position'`
    );
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-begin-termination-preparing'`
    );
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-begin-termination'`
    );
    await queryRunner.query(
      `ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-finalize-termination'`
    );
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-withdraw-fees'`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-pause'`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-unpause'`);

    await queryRunner.query(
      `CREATE TYPE "public"."evm_external_positions_status_enum" AS ENUM('active', 'closed', 'failed')`
    );
    await queryRunner.query(`
      CREATE TABLE "evm_external_positions" (
        "id"                   uuid              NOT NULL DEFAULT uuid_generate_v4(),
        "vault_id"             uuid              NOT NULL,
        "open_tx_id"           uuid,
        "close_tx_id"          uuid,
        "on_chain_position_id" character varying NOT NULL,
        "adapter"              character varying NOT NULL,
        "protocol"             character varying,
        "underlying_asset"     character varying NOT NULL,
        "amount_deposited"     numeric(78,0)     NOT NULL,
        "position_asset"       character varying NOT NULL,
        "position_amount"      numeric(78,0)     NOT NULL,
        "status"               "public"."evm_external_positions_status_enum" NOT NULL DEFAULT 'active',
        "operation_id"         character varying,
        "underlying_returned"  numeric(78,0),
        "open_tx_hash"         character varying,
        "close_tx_hash"        character varying,
        "open_block_number"    character varying,
        "close_block_number"   character varying,
        "created_at"           timestamptz       NOT NULL DEFAULT now(),
        "updated_at"           timestamptz       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_evm_external_positions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_evm_pos_vault_onchain" ON "evm_external_positions" ("vault_id", "on_chain_position_id")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_evm_pos_vault_status" ON "evm_external_positions" ("vault_id", "status")`
    );
    await queryRunner.query(`CREATE INDEX "IDX_evm_pos_adapter" ON "evm_external_positions" ("adapter")`);
    await queryRunner.query(
      `ALTER TABLE "evm_external_positions" ADD CONSTRAINT "FK_evm_pos_vault" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "evm_external_positions" ADD CONSTRAINT "FK_evm_pos_open_tx" FOREIGN KEY ("open_tx_id") REFERENCES "transactions"("id") ON DELETE SET NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "evm_external_positions" ADD CONSTRAINT "FK_evm_pos_close_tx" FOREIGN KEY ("close_tx_id") REFERENCES "transactions"("id") ON DELETE SET NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "evm_external_positions" DROP CONSTRAINT "FK_evm_pos_close_tx"`);
    await queryRunner.query(`ALTER TABLE "evm_external_positions" DROP CONSTRAINT "FK_evm_pos_open_tx"`);
    await queryRunner.query(`ALTER TABLE "evm_external_positions" DROP CONSTRAINT "FK_evm_pos_vault"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_evm_pos_adapter"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_evm_pos_vault_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_evm_pos_vault_onchain"`);
    await queryRunner.query(`DROP TABLE "evm_external_positions"`);
    await queryRunner.query(`DROP TYPE "public"."evm_external_positions_status_enum"`);

    // ADD VALUE is irreversible in Postgres without recreating the type.
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('create-vault', 'mint', 'payment', 'contribute', 'claim', 'extract', 'extract-dispatch', 'cancel', 'acquire', 'investment', 'burn', 'swap', 'stake', 'unstake', 'harvest', 'compound', 'extract-lp', 'distribute-lp', 'distribution', 'update-vault', 'wayup', 'evm-close-cycle', 'evm-claim', 'evm-refund', 'evm-cancel-cycle', 'all')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum" USING "type"::"text"::"public"."transactions_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);
  }
}
