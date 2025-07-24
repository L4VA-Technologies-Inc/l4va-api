import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaitingOwnerStatusAndReadyForGovernanceState1753362888252 implements MigrationInterface {
  name = 'AddWaitingOwnerStatusAndReadyForGovernanceState1753362888252';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_status_enum" RENAME TO "transactions_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum" AS ENUM('waiting_owner', 'created', 'pending', 'submitted', 'confirmed', 'failed', 'stuck')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" TYPE "public"."transactions_status_enum" USING "status"::"text"::"public"."transactions_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum" RENAME TO "vaults_vault_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum" AS ENUM('draft', 'created', 'published', 'contribution', 'acquire', 'investment', 'ready-for-governance', 'locked', 'governance', 'failed')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum" USING "vault_status"::"text"::"public"."vaults_vault_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum_old"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
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
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum_old" AS ENUM('draft', 'created', 'published', 'contribution', 'acquire', 'investment', 'locked', 'governance', 'failed')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum_old" USING "vault_status"::"text"::"public"."vaults_vault_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum_old" RENAME TO "vaults_vault_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_status_enum_old" AS ENUM('created', 'pending', 'submitted', 'confirmed', 'failed', 'stuck')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "status" TYPE "public"."transactions_status_enum_old" USING "status"::"text"::"public"."transactions_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_status_enum_old" RENAME TO "transactions_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
