import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewTransactionType1761147079070 implements MigrationInterface {
  name = 'AddNewTransactionType1761147079070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('mint', 'payment', 'contribute', 'claim', 'extract', 'extract-dispatch', 'cancel', 'acquire', 'investment', 'burn', 'swap', 'stake', 'extract-lp', 'distribute-lp', 'update-vault')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum" USING "type"::"text"::"public"."transactions_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum_old"`);
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
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum_old" AS ENUM('mint', 'payment', 'contribute', 'claim', 'extract', 'cancel', 'acquire', 'investment', 'burn', 'swap', 'stake', 'extract-lp', 'distribute-lp', 'update-vault')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum_old" USING "type"::"text"::"public"."transactions_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum_old" RENAME TO "transactions_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
