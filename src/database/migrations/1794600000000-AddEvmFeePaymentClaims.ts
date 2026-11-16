import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per EVM fee payment hash that has been accepted. The primary key makes
 * the claim atomic, so one on-chain payment can back exactly one contribution,
 * vote or proposal even when requests race. Backfilled from already-recorded
 * payment transactions so old hashes stay spent.
 */
export class AddEvmFeePaymentClaims1794600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "evm_fee_payment_claims" (
        "tx_hash" varchar(66) PRIMARY KEY,
        "from_address" varchar(42) NOT NULL,
        "value_wei" numeric(78, 0) NOT NULL,
        "claimed_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO "evm_fee_payment_claims" ("tx_hash", "from_address", "value_wei")
      SELECT DISTINCT ON (LOWER("tx_hash")) LOWER("tx_hash"), '', 0
        FROM "transactions"
       WHERE "type" = 'payment' AND "tx_hash" ~* '^0x[0-9a-f]{64}$'
      ON CONFLICT ("tx_hash") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "evm_fee_payment_claims"`);
  }
}
