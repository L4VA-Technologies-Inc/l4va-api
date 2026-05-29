import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVyfiPlatformEnum1780064486958 implements MigrationInterface {
  name = 'AddVyfiPlatformEnum1780064486958';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename the old enum type
    await queryRunner.query(
      `ALTER TYPE "public"."token_verifications_platform_enum" RENAME TO "token_verifications_platform_enum_old"`
    );

    // Create the new enum type with 'vyfi' added
    await queryRunner.query(
      `CREATE TYPE "public"."token_verifications_platform_enum" AS ENUM('dexhunter', 'wayup', 'taptools', 'vyfi', 'manual', 'jpg.store')`
    );

    // Update the column to use the new enum type
    await queryRunner.query(
      `ALTER TABLE "token_verifications" ALTER COLUMN "platform" TYPE "public"."token_verifications_platform_enum" USING "platform"::"text"::"public"."token_verifications_platform_enum"`
    );

    // Drop the old enum type
    await queryRunner.query(`DROP TYPE "public"."token_verifications_platform_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rename the current enum type
    await queryRunner.query(
      `ALTER TYPE "public"."token_verifications_platform_enum" RENAME TO "token_verifications_platform_enum_old"`
    );

    // Recreate the old enum type without 'vyfi'
    await queryRunner.query(
      `CREATE TYPE "public"."token_verifications_platform_enum" AS ENUM('dexhunter', 'wayup', 'taptools', 'manual', 'jpg.store')`
    );

    // Update the column to use the old enum type
    await queryRunner.query(
      `ALTER TABLE "token_verifications" ALTER COLUMN "platform" TYPE "public"."token_verifications_platform_enum" USING "platform"::"text"::"public"."token_verifications_platform_enum"`
    );

    // Drop the renamed enum type
    await queryRunner.query(`DROP TYPE "public"."token_verifications_platform_enum_old"`);
  }
}
