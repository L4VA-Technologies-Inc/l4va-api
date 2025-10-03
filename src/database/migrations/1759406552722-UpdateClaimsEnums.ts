import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateClaimsEnums1759406552722 implements MigrationInterface {
  name = 'UpdateClaimsEnums1759406552722';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum" RENAME TO "claims_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum" AS ENUM('lp', 'contributor', 'acquirer', 'l4va', 'final_distribution', 'cancellation')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum" USING "type"::"text"::"public"."claims_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."claims_status_enum" RENAME TO "claims_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_status_enum" AS ENUM('available', 'pending', 'claimed', 'failed')`
    );
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "status" TYPE "public"."claims_status_enum" USING "status"::"text"::"public"."claims_status_enum"`
    );
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "status" SET DEFAULT 'available'`);
    await queryRunner.query(`DROP TYPE "public"."claims_status_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`CREATE TYPE "public"."claims_status_enum_old" AS ENUM('available', 'pending', 'claimed')`);
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "status" TYPE "public"."claims_status_enum_old" USING "status"::"text"::"public"."claims_status_enum_old"`
    );
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "status" SET DEFAULT 'available'`);
    await queryRunner.query(`DROP TYPE "public"."claims_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."claims_status_enum_old" RENAME TO "claims_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum_old" AS ENUM('lp', 'contributor', 'acquirer', 'l4va', 'final_distribution')`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ALTER COLUMN "type" TYPE "public"."claims_type_enum_old" USING "type"::"text"::"public"."claims_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."claims_type_enum_old" RENAME TO "claims_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
