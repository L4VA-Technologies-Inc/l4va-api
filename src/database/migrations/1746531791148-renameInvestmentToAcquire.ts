import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameInvestmentToAcquire1746531791148 implements MigrationInterface {
  name = 'RenameInvestmentToAcquire1746531791148';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT IF EXISTS "FK_3e6ff48532fbe552bbb6c4098bd"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT IF EXISTS "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT IF EXISTS "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "investment_open_window_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."vaults_investment_open_window_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "investment_open_window_time"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "ft_investment_reserve"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT IF EXISTS "REL_3e6ff48532fbe552bbb6c4098b"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "investors_whitelist_csv_id"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "investment_phase_start"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN IF EXISTS "investment_window_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquire_window_duration" bigint`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_acquire_open_window_type_enum" AS ENUM('custom', 'upon-asset-window-closing')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD "acquire_open_window_type" "public"."vaults_acquire_open_window_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquire_open_window_time" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_acquire_reserve" numeric`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquire_phase_start" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquirer_whitelist_csv_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "UQ_c211339d9110a71f1e7b65d87b5" UNIQUE ("acquirer_whitelist_csv_id")`
    );
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum" RENAME TO "transactions_type_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum" AS ENUM('mint', 'payment', 'contribute', 'acquire', 'investment', 'burn', 'swap', 'stake')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum" USING "type"::"text"::"public"."transactions_type_enum"`
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."transactions_type_enum_old"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum" RENAME TO "vaults_vault_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum" AS ENUM('draft', 'created', 'published', 'contribution', 'acquire', 'investment', 'locked', 'governance')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum" USING "vault_status"::"text"::"public"."vaults_vault_status_enum"`
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."vaults_vault_status_enum_old"`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_c211339d9110a71f1e7b65d87b5" FOREIGN KEY ("acquirer_whitelist_csv_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_c211339d9110a71f1e7b65d87b5"`);
    await queryRunner.query(`ALTER TABLE "acquirer_whitelist" DROP CONSTRAINT "FK_cba6b5306e74553edd3b94a000a"`);

    await queryRunner.query(
      `CREATE TYPE "public"."vaults_vault_status_enum_old" AS ENUM('draft', 'created', 'published', 'contribution', 'investment', 'locked', 'governance')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ALTER COLUMN "vault_status" TYPE "public"."vaults_vault_status_enum_old" USING "vault_status"::"text"::"public"."vaults_vault_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."vaults_vault_status_enum_old" RENAME TO "vaults_vault_status_enum"`);
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_type_enum_old" AS ENUM('mint', 'payment', 'contribute', 'investment', 'burn', 'swap', 'stake')`
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ALTER COLUMN "type" TYPE "public"."transactions_type_enum_old" USING "type"::"text"::"public"."transactions_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."transactions_type_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."transactions_type_enum_old" RENAME TO "transactions_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "UQ_c211339d9110a71f1e7b65d87b5"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquirer_whitelist_csv_id"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_phase_start"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_acquire_reserve"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_open_window_time"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_open_window_type"`);
    await queryRunner.query(`DROP TYPE "public"."vaults_acquire_open_window_type_enum"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_window_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_window_duration" bigint`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_phase_start" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investors_whitelist_csv_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "REL_3e6ff48532fbe552bbb6c4098b" UNIQUE ("investors_whitelist_csv_id")`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_investment_reserve" numeric`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_open_window_time" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `CREATE TYPE "public"."vaults_investment_open_window_type_enum" AS ENUM('custom', 'upon-asset-window-closing')`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD "investment_open_window_type" "public"."vaults_investment_open_window_type_enum"`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_3e6ff48532fbe552bbb6c4098bd" FOREIGN KEY ("investors_whitelist_csv_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
