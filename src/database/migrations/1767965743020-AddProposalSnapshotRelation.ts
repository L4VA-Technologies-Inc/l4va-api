import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProposalSnapshotRelation1767965743020 implements MigrationInterface {
  name = ' AddProposalSnapshotRelation1767965743020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);

    // Convert snapshot_id from varchar to uuid (preserving data)
    await queryRunner.query(`ALTER TABLE "proposal" ALTER COLUMN "snapshot_id" TYPE uuid USING "snapshot_id"::uuid`);
    await queryRunner.query(`ALTER TABLE "proposal" ALTER COLUMN "snapshot_id" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "proposal" ADD CONSTRAINT "FK_b212b1d059e835d3fab7f469f5c" FOREIGN KEY ("snapshot_id") REFERENCES "snapshot"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "proposal" DROP CONSTRAINT "FK_b212b1d059e835d3fab7f469f5c"`);

    // Revert snapshot_id back to varchar
    await queryRunner.query(`ALTER TABLE "proposal" ALTER COLUMN "snapshot_id" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "snapshot_id" TYPE character varying USING "snapshot_id"::text`
    );

    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
