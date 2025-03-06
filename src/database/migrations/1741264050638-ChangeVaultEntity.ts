import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeVaultEntity1741264050638 implements MigrationInterface {
    name = 'ChangeVaultEntity1741264050638'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "links" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "url" character varying NOT NULL, "name" character varying NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "vaultId" uuid, CONSTRAINT "PK_ecf17f4a741d3c5ba0b4c5ab4b6" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "socialLinks"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_valuation_type_enum" AS ENUM('lbe')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "valuation_type" "public"."vaults_valuation_type_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_contribution_open_window_type_enum" AS ENUM('custom', 'upon-vault-lunch')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "contribution_open_window_type" "public"."vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "contribution_open_window_time" character varying`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_window" interval`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_count_cap_min" integer`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_count_cap_max" integer`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_window_duration" interval`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_investment_open_window_type_enum" AS ENUM('custom', 'upon-asset-window-closing')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_open_window_type" "public"."vaults_investment_open_window_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "investment_open_window_time" interval`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "off_assets_offered" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_investment_window" interval`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_investment_reverse" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "liquidity_pool_contribution" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_token_supply" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ft_token_decimals" smallint NOT NULL DEFAULT '1'`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_termination_type_enum" AS ENUM('dao', 'programmed')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "termination_type" "public"."vaults_termination_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "time_elapsed_is_equal_to_time" interval`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "asset_appreciation" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "creation_threshold" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "start_threshold" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "vote_threshold" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "execution_threshold" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "cosigning_threshold" numeric(5,2) NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "ftTokenImgId" uuid`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "UQ_e0aa86e723360729933673c514e" UNIQUE ("ftTokenImgId")`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "type"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_type_enum" AS ENUM('single', 'multi', 'ctn')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "type" "public"."vaults_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "privacy"`);
        await queryRunner.query(`CREATE TYPE "public"."vaults_privacy_enum" AS ENUM('private', 'public', 'semi-private')`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "privacy" "public"."vaults_privacy_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "CHK_9d2496e0bc2b30a41372df4bd4" CHECK ("ft_token_decimals" BETWEEN 1 AND 9)`);
        await queryRunner.query(`ALTER TABLE "links" ADD CONSTRAINT "FK_145012215d1a97515045abe0c8f" FOREIGN KEY ("vaultId") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD CONSTRAINT "FK_e0aa86e723360729933673c514e" FOREIGN KEY ("ftTokenImgId") REFERENCES "files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "FK_e0aa86e723360729933673c514e"`);
        await queryRunner.query(`ALTER TABLE "links" DROP CONSTRAINT "FK_145012215d1a97515045abe0c8f"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "CHK_9d2496e0bc2b30a41372df4bd4"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "privacy"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_privacy_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "privacy" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "type"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "type" character varying NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP CONSTRAINT "UQ_e0aa86e723360729933673c514e"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ftTokenImgId"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "cosigning_threshold"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "execution_threshold"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "vote_threshold"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "start_threshold"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "creation_threshold"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_appreciation"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "time_elapsed_is_equal_to_time"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "termination_type"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_termination_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_token_decimals"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_token_supply"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "liquidity_pool_contribution"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_investment_reverse"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "ft_investment_window"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "off_assets_offered"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "investment_open_window_time"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "investment_open_window_type"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_investment_open_window_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "investment_window_duration"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_count_cap_max"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_count_cap_min"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "asset_window"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "contribution_open_window_time"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "contribution_open_window_type"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_contribution_open_window_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" DROP COLUMN "valuation_type"`);
        await queryRunner.query(`DROP TYPE "public"."vaults_valuation_type_enum"`);
        await queryRunner.query(`ALTER TABLE "vaults" ADD "socialLinks" jsonb`);
        await queryRunner.query(`DROP TABLE "links"`);
    }

}
