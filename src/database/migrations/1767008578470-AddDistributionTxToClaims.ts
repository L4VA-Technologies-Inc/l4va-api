import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDistributionTxToClaims1767008578470 implements MigrationInterface {
  name = 'AddDistributionTxToClaims1767008578470';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "claims" ADD "distribution_tx_id" uuid`);
    await queryRunner.query(
      `COMMENT ON COLUMN "claims"."distribution_tx_id" IS 'Reference to the transaction that paid out this claim'`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_8719542929b325b818c030b6173"`);
    await queryRunner.query(
      `COMMENT ON COLUMN "claims"."transaction_id" IS 'Reference to the original contribution/acquisition transaction (used to build UTxO reference)'`
    );
    await queryRunner.query(`CREATE INDEX "IDX_d456d48d59da4766190c5a4854" ON "claims" ("distribution_tx_id") `);
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_8719542929b325b818c030b6173" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_d456d48d59da4766190c5a4854d" FOREIGN KEY ("distribution_tx_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_d456d48d59da4766190c5a4854d"`);
    await queryRunner.query(`ALTER TABLE "claims" DROP CONSTRAINT "FK_8719542929b325b818c030b6173"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d456d48d59da4766190c5a4854"`);
    await queryRunner.query(`COMMENT ON COLUMN "claims"."transaction_id" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "FK_8719542929b325b818c030b6173" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "distribution_tx_id"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
