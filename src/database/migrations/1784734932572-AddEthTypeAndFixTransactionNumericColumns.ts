import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEthTypeAndFixTransactionNumericColumns1784734932572 implements MigrationInterface {
  name = 'AddEthTypeAndFixTransactionNumericColumns1784734932572';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════════
    // Part 1: Add 'eth' to the assets_type_enum
    // ═══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum" RENAME TO "assets_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum" AS ENUM('nft', 'ft', 'ada', 'eth')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum" USING "type"::"text"::"public"."assets_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum_old"`);

    // ═══════════════════════════════════════════════════════════════════════
    // Part 2: Change transaction amount and fee columns to numeric(30,0)
    // This supports large wei values (up to 10^30) without losing precision
    // ═══════════════════════════════════════════════════════════════════════
    // USING clause preserves existing integer values during conversion
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "amount" TYPE numeric(30,0) USING "amount"::numeric`
    );
    await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "fee" TYPE numeric(30,0) USING "fee"::numeric`);

    // ═══════════════════════════════════════════════════════════════════════
    // Part 3: Change assets.quantity column to numeric(30,2)
    // Preserves existing decimal(20,2) scale and expands precision for larger values
    // ═══════════════════════════════════════════════════════════════════════
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "quantity" TYPE numeric(30,2) USING "quantity"::numeric`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════════
    // Rollback Part 3: Revert assets.quantity to decimal(20,2)
    // WARNING: This will truncate to 2 decimal places and lose large wei values
    // ═══════════════════════════════════════════════════════════════════════
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "quantity" TYPE numeric(20,2) USING "quantity"::numeric`
    );

    // ═══════════════════════════════════════════════════════════════════════
    // Rollback Part 2: Revert transaction columns to integer
    // WARNING: This will lose precision for wei values > 2^31-1
    // ═══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "fee" TYPE integer USING "fee"::integer`);
    await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "amount" TYPE integer USING "amount"::integer`);

    // ═══════════════════════════════════════════════════════════════════════
    // Rollback Part 1: Remove 'eth' from assets_type_enum
    // WARNING: This will fail if any assets have type='eth'
    // ═══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum_old" AS ENUM('nft', 'ft', 'ada')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum_old" USING "type"::"text"::"public"."assets_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum_old" RENAME TO "assets_type_enum"`);
  }
}
