import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedContributorWhitelist1742484041497 implements MigrationInterface {
    name = 'AddedContributorWhitelist1742484041497'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`CREATE TABLE "contributor_whitelist" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "wallet_address" character varying NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vault_id" uuid, CONSTRAINT "PK_61db8d3694e74fd55f37c54a54c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "contributor_whitelist" ADD CONSTRAINT "FK_dad5613b25986784cf01e7fdaae" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "contributor_whitelist" DROP CONSTRAINT "FK_dad5613b25986784cf01e7fdaae"`);
        await queryRunner.query(`DROP TABLE "contributor_whitelist"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    }

}
