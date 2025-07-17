import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVaultTrackingFields1752761958847 implements MigrationInterface {
  name = 'AddVaultTrackingFields1752761958847';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "acquire_multiplier" jsonb DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ada_pair_multiplier" numeric DEFAULT '1'`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "last_update_tx_hash" character varying`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "last_update_tx_index" integer DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_policy_id" character varying`);
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_policy_id"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "last_update_tx_index"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "last_update_tx_hash"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ada_pair_multiplier"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "acquire_multiplier"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
