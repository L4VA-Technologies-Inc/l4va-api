import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEthToAssetTypeEnum1784733407448 implements MigrationInterface {
  name = 'AddEthToAssetTypeEnum1784733407448';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add 'eth' to the assets_type_enum
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum" RENAME TO "assets_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum" AS ENUM('nft', 'ft', 'ada', 'eth')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum" USING "type"::"text"::"public"."assets_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove 'eth' from the assets_type_enum
    await queryRunner.query(`CREATE TYPE "public"."assets_type_enum_old" AS ENUM('nft', 'ft', 'ada')`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "type" TYPE "public"."assets_type_enum_old" USING "type"::"text"::"public"."assets_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."assets_type_enum_old" RENAME TO "assets_type_enum"`);
  }
}
