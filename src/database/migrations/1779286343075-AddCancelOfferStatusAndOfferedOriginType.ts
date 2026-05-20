import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCancelOfferStatusAndOfferedOriginType1779286343075 implements MigrationInterface {
  name = 'AddCancelOfferStatusAndOfferedOriginType1779286343075';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum" RENAME TO "assets_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum" AS ENUM('pending', 'locked', 'released', 'distributed', 'extracted', 'listed', 'sold', 'burned', 'offered', 'cancel_offer')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum" USING "status"::"text"::"public"."assets_status_enum"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum_old"`);

    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum" RENAME TO "assets_origin_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_origin_type_enum" AS ENUM('acquired', 'contributed', 'fee', 'bought', 'offered')`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum" USING "origin_type"::"text"::"public"."assets_origin_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum_old"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "public"."assets_origin_type_enum" RENAME TO "assets_origin_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_origin_type_enum" AS ENUM('acquired', 'contributed', 'fee', 'bought')`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "origin_type" TYPE "public"."assets_origin_type_enum" USING "origin_type"::"text"::"public"."assets_origin_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."assets_origin_type_enum_old"`);

    await queryRunner.query(`ALTER TYPE "public"."assets_status_enum" RENAME TO "assets_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."assets_status_enum" AS ENUM('pending', 'locked', 'released', 'distributed', 'extracted', 'listed', 'sold', 'burned', 'offered')`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "assets" ALTER COLUMN "status" TYPE "public"."assets_status_enum" USING "status"::"text"::"public"."assets_status_enum"`
    );
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "status" SET DEFAULT 'pending'`);
    await queryRunner.query(`DROP TYPE "public"."assets_status_enum_old"`);
  }
}
