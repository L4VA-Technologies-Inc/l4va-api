import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGovernanceSystem1754303000063 implements MigrationInterface {
  name = 'AddGovernanceSystem1754303000063';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(
      `CREATE TABLE "snapshot" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vaultId" uuid NOT NULL, "assetId" character varying NOT NULL, "addressBalances" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_47b29c1a6055220b1ebdafdf7b5" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_status_enum" AS ENUM('active', 'passed', 'rejected', 'executed')`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning')`
    );
    await queryRunner.query(
      `CREATE TABLE "proposal" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "title" character varying NOT NULL, "description" text NOT NULL, "status" "public"."proposal_status_enum" NOT NULL, "proposal_type" "public"."proposal_proposal_type_enum" NOT NULL, "ipfsHash" character varying, "externalLink" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "startDate" TIMESTAMP NOT NULL, "endDate" TIMESTAMP, "executionDate" TIMESTAMP, "snapshotId" character varying, "creator_id" uuid NOT NULL, "vault_id" uuid NOT NULL, CONSTRAINT "PK_ca872ecfe4fef5720d2d39e4275" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`CREATE TYPE "public"."vote_vote_enum" AS ENUM('yes', 'no')`);
    await queryRunner.query(
      `CREATE TABLE "vote" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "proposalId" uuid NOT NULL, "snapshotId" uuid NOT NULL, "voterId" character varying NOT NULL, "voterAddress" character varying NOT NULL, "voteWeight" character varying NOT NULL, "vote" "public"."vote_vote_enum" NOT NULL, "timestamp" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2d5932d46afe39c8176f9d4be72" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TABLE "snapshot" ADD CONSTRAINT "FK_d900cb7eec6985da2b97e3bab83" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ADD CONSTRAINT "FK_3ac64b13b3f748e590a260b7e3c" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ADD CONSTRAINT "FK_136b2b58892a0f0e6c1492b7317" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vote" ADD CONSTRAINT "FK_a6099cc53a32762d8c69e71dcd1" FOREIGN KEY ("proposalId") REFERENCES "proposal"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vote" ADD CONSTRAINT "FK_3c5905b3834c0462c3cace33f43" FOREIGN KEY ("snapshotId") REFERENCES "snapshot"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_3c5905b3834c0462c3cace33f43"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_a6099cc53a32762d8c69e71dcd1"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP CONSTRAINT "FK_136b2b58892a0f0e6c1492b7317"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP CONSTRAINT "FK_3ac64b13b3f748e590a260b7e3c"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP CONSTRAINT "FK_d900cb7eec6985da2b97e3bab83"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`DROP TABLE "vote"`);
    await queryRunner.query(`DROP TYPE "public"."vote_vote_enum"`);
    await queryRunner.query(`DROP TABLE "proposal"`);
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum"`);
    await queryRunner.query(`DROP TABLE "snapshot"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
