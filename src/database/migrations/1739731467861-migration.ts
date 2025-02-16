import { MigrationInterface, QueryRunner } from "typeorm";

export class Migration1739731467861 implements MigrationInterface {
    name = 'Migration1739731467861'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "vaults" ("id" SERIAL NOT NULL, "ownerId" integer NOT NULL, "name" character varying NOT NULL, "type" character varying NOT NULL, "privacy" character varying NOT NULL, "brief" character varying, "imageUrl" character varying, "bannerUrl" character varying, "socialLinks" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_487a5346fa3693a430b6d6db60c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_2595182ac08342bf379e1b68657" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_2595182ac08342bf379e1b68657"`);
        await queryRunner.query(`DROP TABLE "vaults"`);
    }

}
