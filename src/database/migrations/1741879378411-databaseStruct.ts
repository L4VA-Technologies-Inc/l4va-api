import { MigrationInterface, QueryRunner } from "typeorm";

export class DatabaseStruct1741879378411 implements MigrationInterface {
    name = 'DatabaseStruct1741879378411'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "file_key" character varying NOT NULL, "file_url" character varying NOT NULL, "file_type" character varying NOT NULL, "file_name" character varying NOT NULL, "metadata" jsonb, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url" character varying NOT NULL, "name" character varying NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vault_id" uuid, "user_id" uuid, CONSTRAINT "PK_ecf17f4a741d3c5ba0b4c5ab4b6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "address" character varying NOT NULL, "description" character varying, "tvl" numeric(20,2) NOT NULL DEFAULT '0', "total_vaults" integer NOT NULL DEFAULT '0', "gains" numeric(10,2) NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "profile_image_id" uuid, "banner_image_id" uuid, CONSTRAINT "UQ_b0ec0293d53a1385955f9834d5c" UNIQUE ("address"), CONSTRAINT "REL_96d6f1aafc327443850f263cd5" UNIQUE ("profile_image_id"), CONSTRAINT "REL_657d44500fe38e604f4a630662" UNIQUE ("banner_image_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "investors_whitelist" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "wallet_address" character varying NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vault_id" uuid, CONSTRAINT "PK_8aff9f27f807add95dd73b72f3e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."assets_type_enum" AS ENUM('nft', 'cnt')`);
        await queryRunner.query(`CREATE TYPE "public"."assets_status_enum" AS ENUM('pending', 'locked', 'released')`);
        await queryRunner.query(`CREATE TABLE "assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vault_id" uuid NOT NULL, "type" "public"."assets_type_enum" NOT NULL, "contract_address" character varying NOT NULL, "token_id" character varying, "quantity" numeric(20,2) NOT NULL DEFAULT '0', "floor_price" numeric(20,2), "dex_price" numeric(20,2), "last_valuation" TIMESTAMP WITH TIME ZONE, "status" "public"."assets_status_enum" NOT NULL DEFAULT 'pending', "locked_at" TIMESTAMP WITH TIME ZONE, "released_at" TIMESTAMP WITH TIME ZONE, "metadata" jsonb NOT NULL, "added_by" character varying NOT NULL, "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_da96729a8b113377cfb6a62439c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9dcbee9dfaf5bc1d498d568216" ON "assets" ("vault_id") `);
        await queryRunner.query(`CREATE TYPE "public"."vaults_type_enum" AS ENUM('single', 'multi', 'ctn')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_privacy_enum" AS ENUM('private', 'public', 'semi-private')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_valuation_type_enum" AS ENUM('lbe', 'fixed')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_contribution_open_window_type_enum" AS ENUM('custom', 'upon-vault-lunch')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_investment_open_window_type_enum" AS ENUM('custom', 'upon-asset-window-closing')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_termination_type_enum" AS ENUM('dao', 'programmed')`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_vault_status_enum" AS ENUM('draft', 'published', 'contribution', 'investment', 'locked')`);
        await queryRunner.query(`CREATE TABLE "vaults" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "type" "public"."vaults_type_enum", "privacy" "public"."vaults_privacy_enum", "description" character varying, "valuation_type" "public"."vaults_valuation_type_enum", "contribution_open_window_type" "public"."vaults_contribution_open_window_type_enum", "contribution_open_window_time" TIMESTAMP WITH TIME ZONE, "asset_window" TIMESTAMP WITH TIME ZONE, "investment_window_duration" TIMESTAMP WITH TIME ZONE, "investment_open_window_type" "public"."vaults_investment_open_window_type_enum", "investment_open_window_time" TIMESTAMP WITH TIME ZONE, "tokens_for_acquires" numeric, "ft_investment_window" TIMESTAMP WITH TIME ZONE, "ft_investment_reverse" numeric, "liquidity_pool_contribution" numeric, "ft_token_supply" numeric, "vault_token_ticker" character varying, "ft_token_decimals" smallint DEFAULT '1', "termination_type" "public"."vaults_termination_type_enum", "time_elapsed_is_equal_to_time" TIMESTAMP WITH TIME ZONE, "asset_appreciation" numeric, "creation_threshold" numeric, "start_threshold" numeric, "vote_threshold" numeric, "execution_threshold" numeric, "cosigning_threshold" numeric, "vault_status" "public"."vaults_vault_status_enum", "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "owner_id" uuid, "vault_image_id" uuid, "banner_image_id" uuid, "investors_whitelist_csv_id" uuid, "ft_token_img_id" uuid, CONSTRAINT "REL_bfa8eb1a193e5e4a9dc4d2b725" UNIQUE ("vault_image_id"), CONSTRAINT "REL_a6a3f7811be6df590c8da538d4" UNIQUE ("banner_image_id"), CONSTRAINT "REL_3e6ff48532fbe552bbb6c4098b" UNIQUE ("investors_whitelist_csv_id"), CONSTRAINT "REL_c15eb8818056ac23754262fdd3" UNIQUE ("ft_token_img_id"), CONSTRAINT "CHK_9d2496e0bc2b30a41372df4bd4" CHECK ("ft_token_decimals" BETWEEN 1 AND 9), CONSTRAINT "PK_487a5346fa3693a430b6d6db60c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "assets_whitelist" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "policy_id" character varying(56) NOT NULL, "asset_count_cap_min" integer, "asset_count_cap_max" integer, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vault_id" uuid, CONSTRAINT "PK_85cf89e7248c7f3f4013e524c84" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "links" ADD CONSTRAINT "FK_1e942f889da974dfccec3b4ecbf" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "links" ADD CONSTRAINT "FK_9f8dea86e48a7216c4f5369c1e4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_96d6f1aafc327443850f263cd50" FOREIGN KEY ("profile_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "FK_657d44500fe38e604f4a6306620" FOREIGN KEY ("banner_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "investors_whitelist" ADD CONSTRAINT "FK_4996e41bd51ba848c8f6ac22a03" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "assets" ADD CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_6f6b9ff91b18b69d88c11e4f5d8" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257" FOREIGN KEY ("vault_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_a6a3f7811be6df590c8da538d40" FOREIGN KEY ("banner_image_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_3e6ff48532fbe552bbb6c4098bd" FOREIGN KEY ("investors_whitelist_csv_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_c15eb8818056ac23754262fdd3a" FOREIGN KEY ("ft_token_img_id") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "assets_whitelist" ADD CONSTRAINT "FK_67ab781bada0c0fd71e38f5d3a4" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "assets_whitelist" DROP CONSTRAINT "FK_67ab781bada0c0fd71e38f5d3a4"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_c15eb8818056ac23754262fdd3a"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_3e6ff48532fbe552bbb6c4098bd"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_a6a3f7811be6df590c8da538d40"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_bfa8eb1a193e5e4a9dc4d2b7257"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_6f6b9ff91b18b69d88c11e4f5d8"`);
        await queryRunner.query(`ALTER TABLE "assets" DROP CONSTRAINT "FK_9dcbee9dfaf5bc1d498d568216f"`);
        await queryRunner.query(`ALTER TABLE "investors_whitelist" DROP CONSTRAINT "FK_4996e41bd51ba848c8f6ac22a03"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_657d44500fe38e604f4a6306620"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_96d6f1aafc327443850f263cd50"`);
        await queryRunner.query(`ALTER TABLE "links" DROP CONSTRAINT "FK_9f8dea86e48a7216c4f5369c1e4"`);
        await queryRunner.query(`ALTER TABLE "links" DROP CONSTRAINT "FK_1e942f889da974dfccec3b4ecbf"`);
        await queryRunner.query(`DROP TABLE "assets_whitelist"`);
        await queryRunner.query(`DROP TABLE "vaults"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_vault_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_termination_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_investment_open_window_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_valuation_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_privacy_enum"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9dcbee9dfaf5bc1d498d568216"`);
        await queryRunner.query(`DROP TABLE "assets"`);
        await queryRunner.query(`DROP TYPE "public"."assets_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."assets_type_enum"`);
        await queryRunner.query(`DROP TABLE "investors_whitelist"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "links"`);
        await queryRunner.query(`DROP TABLE "files"`);
    }

}
