import { MigrationInterface, QueryRunner } from 'typeorm';

export class TransactionModelFix1743089378621 implements MigrationInterface {
  name = 'TransactionModelFix1743089378621';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('mint', 'payment', 'contribute', 'burn', 'swap', 'stake')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('created', 'pending', 'submitted', 'confirmed', 'failed', 'manual-review')`
    );
    await queryRunner.query(
      `CREATE TABLE "transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "sender" character varying NOT NULL, "receiver" character varying NOT NULL, "type" "public"."transactions_type_enum", "fee" integer NOT NULL, "tx_hash" character varying NOT NULL, "block" integer NOT NULL, "status" "public"."transactions_status_enum", "metadata" jsonb, CONSTRAINT "PK_a219afd8dd77ed80f5a862f1db9" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`ALTER TYPE "public"."vaults_type_enum" RENAME TO "vaults_type_enum_old"`);
    await queryRunner.query(`CREATE TYPE "public"."vaults_type_enum" AS ENUM('single', 'multi', 'ctn', 'cnt')`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "type" TYPE "public"."vaults_type_enum" USING "type"::"text"::"public"."vaults_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_type_enum_old"`);
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
    await queryRunner.query(`CREATE TYPE "public"."vaults_type_enum_old" AS ENUM('single', 'multi', 'ctn')`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "type" TYPE "public"."vaults_type_enum_old" USING "type"::"text"::"public"."vaults_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_type_enum_old" RENAME TO "vaults_type_enum"`);
    await queryRunner.query(`DROP TABLE "transactions"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
}
