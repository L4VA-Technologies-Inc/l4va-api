import { MigrationInterface, QueryRunner } from "typeorm";

export class AddedTransactionModelAndRelations1743588383672 implements MigrationInterface {
    name = 'AddedTransactionModelAndRelations1743588383672'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "sender"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "receiver"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "block"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "metadata"`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "utxo_input" character varying`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "utxo_output" character varying`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "utxo_ref" character varying`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "amount" integer`);
        await queryRunner.query(`ALTER TABLE "assets" ADD "transaction_id" uuid`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "fee" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "tx_hash" DROP NOT NULL`);
        await queryRunner.query(`ALTER TYPE "public"."transactions_status_enum" RENAME TO "transactions_status_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."transactions_status_enum" AS ENUM('created', 'pending', 'submitted', 'confirmed', 'failed', 'stuck')`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "status" TYPE "public"."transactions_status_enum" USING "status"::"text"::"public"."transactions_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."transactions_status_enum_old"`);
        await queryRunner.query(`ALTER TABLE "assets" ADD CONSTRAINT "FK_20094ffc712b516cb4a7444de3b" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
        await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
        await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_20094ffc712b516cb4a7444de3b"`);
        await queryRunner.query(`CREATE TYPE "public"."transactions_status_enum_old" AS ENUM('created', 'pending', 'submitted', 'confirmed', 'failed', 'manual-review')`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "status" TYPE "public"."transactions_status_enum_old" USING "status"::"text"::"public"."transactions_status_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."transactions_status_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."transactions_status_enum_old" RENAME TO "transactions_status_enum"`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "tx_hash" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "transactions" ALTER COLUMN "fee" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "transaction_id"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "amount"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "utxo_ref"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "utxo_output"`);
        await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "utxo_input"`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "metadata" jsonb`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "block" integer NOT NULL`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "receiver" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "transactions" ADD "sender" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
