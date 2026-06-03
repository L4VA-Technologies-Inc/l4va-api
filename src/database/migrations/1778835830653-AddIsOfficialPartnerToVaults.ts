import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIsOfficialPartnerToVaults1778835830653 implements MigrationInterface {
  name = 'AddIsOfficialPartnerToVaults1778835830653';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" ADD "is_official_partner" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "is_official_partner"`);
  }
}
