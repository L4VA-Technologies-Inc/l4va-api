import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeAssetsOwnerType1743678745097 implements MigrationInterface {
  name = 'ChangeAssetsOwnerType1743678745097';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_9dcbee9dfaf5bc1d498d568216"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "token_id"`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "policy_id" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "asset_id" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f"`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "contract_address" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "vault_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "added_by"`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "added_by" uuid`);
    await queryRunner.query(
      `ALTER TABLE "assets" ADD CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD CONSTRAINT "FK_969c7c69dd286d6e17dedd27923" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_969c7c69dd286d6e17dedd27923"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "added_by"`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "added_by" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "vault_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "assets" ALTER COLUMN "contract_address" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "assets" ADD CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "asset_id"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "policy_id"`);
    await queryRunner.query(`ALTER TABLE "assets" ADD "token_id" character varying`);
    await queryRunner.query(`CREATE INDEX "IDX_9dcbee9dfaf5bc1d498d568216" ON "assets" ("vault_id") `);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
