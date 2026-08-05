import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEvmTransactionTypes1785938643414 implements MigrationInterface {
  name = 'AddEvmTransactionTypes1785938643414';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-open-cycle'`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" ADD VALUE IF NOT EXISTS 'evm-open-position'`);
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
