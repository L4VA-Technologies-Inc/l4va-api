import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmailVerification1789400000000 implements MigrationInterface {
  name = 'AddEmailVerification1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "email_verified" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "users" ADD "email_verification_token_hash" character varying`);
    await queryRunner.query(`ALTER TABLE "users" ADD "email_verification_expires_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "users" ADD "email_verification_sent_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_users_email_verification_token_hash" ON "users" ("email_verification_token_hash") WHERE "email_verification_token_hash" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_users_email_verification_token_hash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verification_sent_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verification_expires_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verification_token_hash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email_verified"`);
  }
}
