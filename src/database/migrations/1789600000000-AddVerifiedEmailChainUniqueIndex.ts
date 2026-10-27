import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wallets are linked across chains by a shared verified email: at most one wallet per chain per email.
 */
export class AddVerifiedEmailChainUniqueIndex1789600000000 implements MigrationInterface {
  name = 'AddVerifiedEmailChainUniqueIndex1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing duplicates would block the index: keep the oldest wallet verified, the rest must re-verify
    await queryRunner.query(`
      UPDATE "users" SET "email_verified" = false
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id", ROW_NUMBER() OVER (PARTITION BY LOWER("email"), "chain_type" ORDER BY "created_at", "id") AS rn
          FROM "users"
          WHERE "email_verified" = true AND "deleted" = false AND "email" IS NOT NULL
        ) ranked
        WHERE ranked.rn > 1
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_verified_email_chain" ON "users" (LOWER("email"), "chain_type") WHERE "email_verified" = true AND "deleted" = false AND "email" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_users_verified_email_chain"`);
  }
}
