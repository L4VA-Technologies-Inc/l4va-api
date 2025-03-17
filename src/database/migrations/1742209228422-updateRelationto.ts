import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdateRelationto1742209228422 implements MigrationInterface {
    name = 'UpdateRelationto1742209228422'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_appreciation"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "valuation_currency" character varying`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "valuation_amount" numeric`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "vault_appreciation" numeric`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vault_appreciation"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "valuation_amount"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "valuation_currency"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_appreciation" numeric`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    }

}
