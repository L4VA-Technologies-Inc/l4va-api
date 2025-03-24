import { MigrationInterface, QueryRunner } from "typeorm";

export class RenameFieldFixEnum1742800375799 implements MigrationInterface {
    name = 'RenameFieldFixEnum1742800375799'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TYPE "public"."vaults_contribution_open_window_type_enum" RENAME TO "vaults_contribution_open_window_type_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_contribution_open_window_type_enum" AS ENUM('custom', 'upon-vault-lunch', 'upon-vault-launch')`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "contribution_open_window_type" TYPE "public"."vaults_contribution_open_window_type_enum" USING "contribution_open_window_type"::"text"::"public"."vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_contribution_open_window_type_enum_old"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`UPDATE vaults SET contribution_open_window_type = 'upon-vault-launch' WHERE contribution_open_window_type = 'upon-vault-lunch';`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_contribution_open_window_type_enum_old" AS ENUM('custom', 'upon-vault-lunch')`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "contribution_open_window_type" TYPE "public"."vaults_contribution_open_window_type_enum_old" USING "contribution_open_window_type"::"text"::"public"."vaults_contribution_open_window_type_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."vaults_contribution_open_window_type_enum_old" RENAME TO "vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
      await queryRunner.query(`UPDATE vaults SET contribution_open_window_type = 'upon-vault-lunch' WHERE contribution_open_window_type = 'upon-vault-launch';`)
    }

}
