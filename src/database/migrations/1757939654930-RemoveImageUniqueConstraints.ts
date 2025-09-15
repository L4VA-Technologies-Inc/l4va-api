import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveImageUniqueConstraints1757939654930 implements MigrationInterface {
  name = 'RemoveImageUniqueConstraints1757939654930';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_c15eb8818056ac23754262fdd3a"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "REL_bfa8eb1a193e5e4a9dc4d2b725"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "REL_c15eb8818056ac23754262fdd3"`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257" FOREIGN KEY ("vault_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_c15eb8818056ac23754262fdd3a" FOREIGN KEY ("ft_token_img_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_c15eb8818056ac23754262fdd3a"`);
    await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257"`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "REL_c15eb8818056ac23754262fdd3" UNIQUE ("ft_token_img_id")`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "REL_bfa8eb1a193e5e4a9dc4d2b725" UNIQUE ("vault_image_id")`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_c15eb8818056ac23754262fdd3a" FOREIGN KEY ("ft_token_img_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vaults" ADD CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257" FOREIGN KEY ("vault_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
