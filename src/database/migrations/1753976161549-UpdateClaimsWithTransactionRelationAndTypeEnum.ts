import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateClaimsWithTransactionRelationAndTypeEnum1753976161549 implements MigrationInterface {
  name = 'UpdateClaimsWithTransactionRelationAndTypeEnum1753976161549';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);

    // Create a temporary column to hold the original type values
    await queryRunner.query(`ALTER TABLE "claims" ADD "type_old" character varying`);
    await queryRunner.query(`UPDATE "claims" SET "type_old" = "type"`);

    // Now drop the original type column
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "tx_hash"`);
    await queryRunner.query(`ALTER TABLE "transactions" ADD "tx_index" character varying`);
    await queryRunner.query(`ALTER TABLE "claims" ADD "transaction_id" uuid`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "type"`);

    // Create the enum type and a new type column that allows NULL initially
    await queryRunner.query(
      `CREATE TYPE "public"."claims_type_enum" AS ENUM('lp', 'contributor', 'acquirer', 'l4va', 'final_distribution')`
    );
    await queryRunner.query(`ALTER TABLE "claims" ADD "type" "public"."claims_type_enum"`);

    // Update the new column with values from the old one
    await queryRunner.query(`UPDATE "claims" SET "type" = "type_old"::"public"."claims_type_enum"`);

    // Now make the column NOT NULL
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "type" SET NOT NULL`);

    // Drop the temporary column
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "type_old"`);

    // Continue with the rest of the migration
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`CREATE INDEX "IDX_8719542929b325b818c030b617" ON "claims" ("transaction_id") `);
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_8719542929b325b818c030b6173" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
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
    await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_8719542929b325b818c030b6173"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8719542929b325b818c030b617"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);

    // Create a temporary column for the rollback
    await queryRunner.query(`ALTER TABLE "claims" ADD "type_old" character varying`);
    await queryRunner.query(`UPDATE "claims" SET "type_old" = "type"::text`);

    // Drop the enum column
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "type"`);
    await queryRunner.query(`DROP TYPE "public"."claims_type_enum"`);

    // Create a new varchar column and populate it
    await queryRunner.query(`ALTER TABLE "claims" ADD "type" character varying`);
    await queryRunner.query(`UPDATE "claims" SET "type" = "type_old"`);
    await queryRunner.query(`ALTER TABLE "claims" ALTER COLUMN "type" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "type_old"`);

    // Finish the rollback
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "transaction_id"`);
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "tx_index"`);
    await queryRunner.query(`ALTER TABLE "claims" ADD "tx_hash" character varying`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
