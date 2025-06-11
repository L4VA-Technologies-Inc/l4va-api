import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddedTags1741943808652 implements MigrationInterface {
  name = 'AddedTags1741943808652';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tags" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, CONSTRAINT "UQ_d90243459a697eadb8ad56e9092" UNIQUE ("name"), CONSTRAINT "PK_e7dc17249a1148a1970748eda99" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE TABLE "vault_tags" ("tag_id" uuid NOT NULL, "vault_id" uuid NOT NULL, CONSTRAINT "PK_b43bcaa347028f52de05c137789" PRIMARY KEY ("tag_id", "vault_id"))`
    );
    await queryRunner.query(`CREATE INDEX "IDX_2b3fd4667b2be7a2d7a329083c" ON "vault_tags" ("tag_id") `);
    await queryRunner.query(`CREATE INDEX "IDX_adf9f0b047319be1ec67ac1d1e" ON "vault_tags" ("vault_id") `);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_window"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_investment_window"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "contribution_duration" interval`);
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "contribution_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_investment_window" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_window" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`DROP INDEX "public"."IDX_adf9f0b047319be1ec67ac1d1e"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2b3fd4667b2be7a2d7a329083c"`);
    await queryRunner.query(`DROP TABLE "vault_tags"`);
    await queryRunner.query(`DROP TABLE "tags"`);
  }
}
