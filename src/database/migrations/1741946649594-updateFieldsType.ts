import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateFieldsType1741946649594 implements MigrationInterface {
  name = 'UpdateFieldsType1741946649594';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "investment_window_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_window_duration" interval`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "time_elapsed_is_equal_to_time"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "time_elapsed_is_equal_to_time" interval`);
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "time_elapsed_is_equal_to_time"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "time_elapsed_is_equal_to_time" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "investment_window_duration"`);
    await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_window_duration" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
  }
}
