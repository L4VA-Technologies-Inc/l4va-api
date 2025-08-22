import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateEntitiesColumnNamingAndProposalStatus1755862693887 implements MigrationInterface {
  name = 'UpdateEntitiesColumnNamingAndProposalStatus1755862693887';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "snapshot" DROP CONSTRAINT "FK_d900cb7eec6985da2b97e3bab83"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_3c5905b3834c0462c3cace33f43"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_a6099cc53a32762d8c69e71dcd1"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP CONSTRAINT "FK_136b2b58892a0f0e6c1492b7317"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "vaultId"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "assetId"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "createdAt"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "proposalId"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "snapshotId"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "voterId"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "voterAddress"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "voteWeight"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "externalLink"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "snapshotId"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "executionDate"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "endDate"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "startDate"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "createdAt"`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "vault_id" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "asset_id" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "proposal_id" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "voter_address" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "vote_weight" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "snapshot_id" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "voter_id" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "external_link" character varying`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "start_date" TIMESTAMP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "end_date" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "execution_date" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "snapshot_id" character varying`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "created_at" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TYPE "public"."proposal_status_enum" RENAME TO "proposal_status_enum_old"`);
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_status_enum" AS ENUM('upcomming', 'active', 'passed', 'rejected', 'executed')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "status" TYPE "public"."proposal_status_enum" USING "status"::"text"::"public"."proposal_status_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum_old"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TABLE "snapshot" ADD CONSTRAINT "FK_17b5d7ee165b6abe658c9b9478e" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vote" ADD CONSTRAINT "FK_db85a3f8526cbaa2865faf8637f" FOREIGN KEY ("proposal_id") REFERENCES "proposal"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vote" ADD CONSTRAINT "FK_d60f1c0960c6a43ccc24a4ef127" FOREIGN KEY ("snapshot_id") REFERENCES "snapshot"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vote" ADD CONSTRAINT "FK_f5c90d8438424ec0f044ef945a9" FOREIGN KEY ("voter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ADD CONSTRAINT "FK_136b2b58892a0f0e6c1492b7317" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "proposal" DROP CONSTRAINT "FK_136b2b58892a0f0e6c1492b7317"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_f5c90d8438424ec0f044ef945a9"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_d60f1c0960c6a43ccc24a4ef127"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP CONSTRAINT "FK_db85a3f8526cbaa2865faf8637f"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP CONSTRAINT "FK_17b5d7ee165b6abe658c9b9478e"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_status_enum_old" AS ENUM('active', 'passed', 'rejected', 'executed')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "status" TYPE "public"."proposal_status_enum_old" USING "status"::"text"::"public"."proposal_status_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum"`);
    await queryRunner.query(`ALTER TYPE "public"."proposal_status_enum_old" RENAME TO "proposal_status_enum"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "snapshot_id"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "execution_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "end_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "start_date"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "external_link"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "voter_id"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "snapshot_id"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "vote_weight"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "voter_address"`);
    await queryRunner.query(`ALTER TABLE "vote" DROP COLUMN "proposal_id"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "asset_id"`);
    await queryRunner.query(`ALTER TABLE "snapshot" DROP COLUMN "vault_id"`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "startDate" TIMESTAMP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "endDate" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "executionDate" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "snapshotId" character varying`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "externalLink" character varying`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "voteWeight" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "voterAddress" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "voterId" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "snapshotId" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "vote" ADD "proposalId" uuid NOT NULL`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "createdAt" TIMESTAMP NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "assetId" character varying NOT NULL`);
    await queryRunner.query(`ALTER TABLE "snapshot" ADD "vaultId" uuid NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
      `ALTER TABLE "snapshot" ADD CONSTRAINT "FK_d900cb7eec6985da2b97e3bab83" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
