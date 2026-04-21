import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTokenStakingPosition1776845399295 implements MigrationInterface {
  name = 'AddTokenStakingPosition1776845399295';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);
    await queryRunner.query(`CREATE TYPE "public"."token_staking_positions_token_type_enum" AS ENUM('L4VA', 'VLRM')`);
    await queryRunner.query(`CREATE TYPE "public"."token_staking_positions_status_enum" AS ENUM('ACTIVE', 'CLOSED')`);
    await queryRunner.query(
      `CREATE TABLE "token_staking_positions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "token_type" "public"."token_staking_positions_token_type_enum" NOT NULL, "amount" bigint NOT NULL DEFAULT '0', "status" "public"."token_staking_positions_status_enum" NOT NULL DEFAULT 'ACTIVE', "stake_tx_id" uuid, "unstake_tx_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7808450e5a4814b58d89942450f" PRIMARY KEY ("id")); COMMENT ON COLUMN "token_staking_positions"."amount" IS 'Smallest on-chain units. Staked token amount.'; COMMENT ON COLUMN "token_staking_positions"."stake_tx_id" IS 'Reference to the transaction that created this staking position'; COMMENT ON COLUMN "token_staking_positions"."unstake_tx_id" IS 'Reference to the transaction that closed this staking position'`
    );
    await queryRunner.query(`CREATE INDEX "IDX_bc4be46b743b83f4db89ea8d47" ON "token_staking_positions" ("user_id") `);
    await queryRunner.query(
      `CREATE INDEX "IDX_1aabc283beebaf4714b18171fa" ON "token_staking_positions" ("stake_tx_id") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c44c5c6791caaff8cd66adfa02" ON "token_staking_positions" ("unstake_tx_id") `
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_24b06071998e322795d1b680db" ON "token_staking_positions" ("user_id", "token_type", "status") `
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TABLE "token_staking_positions" ADD CONSTRAINT "FK_bc4be46b743b83f4db89ea8d47c" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "token_staking_positions" ADD CONSTRAINT "FK_1aabc283beebaf4714b18171fa8" FOREIGN KEY ("stake_tx_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
    await queryRunner.query(
      `ALTER TABLE "token_staking_positions" ADD CONSTRAINT "FK_c44c5c6791caaff8cd66adfa027" FOREIGN KEY ("unstake_tx_id") REFERENCES "transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
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
    await queryRunner.query(`ALTER TABLE "token_staking_positions" DROP CONSTRAINT "FK_c44c5c6791caaff8cd66adfa027"`);
    await queryRunner.query(`ALTER TABLE "token_staking_positions" DROP CONSTRAINT "FK_1aabc283beebaf4714b18171fa8"`);
    await queryRunner.query(`ALTER TABLE "token_staking_positions" DROP CONSTRAINT "FK_bc4be46b743b83f4db89ea8d47c"`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);
    await queryRunner.query(`DROP INDEX "public"."IDX_24b06071998e322795d1b680db"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_c44c5c6791caaff8cd66adfa02"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_1aabc283beebaf4714b18171fa"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bc4be46b743b83f4db89ea8d47"`);
    await queryRunner.query(`DROP TABLE "token_staking_positions"`);
    await queryRunner.query(`DROP TYPE "public"."token_staking_positions_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."token_staking_positions_token_type_enum"`);
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
