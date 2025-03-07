import { MigrationInterface, QueryRunner } from "typeorm";

export class NullConstraints1741270469013 implements MigrationInterface {
    name = 'NullConstraints1741270469013'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "off_assets_offered" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_investment_reverse" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "liquidity_pool_contribution" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_token_supply" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_token_decimals" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "asset_appreciation" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "creation_threshold" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "start_threshold" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "vote_threshold" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "execution_threshold" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "cosigning_threshold" DROP NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "cosigning_threshold" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "execution_threshold" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "vote_threshold" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "start_threshold" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "creation_threshold" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "asset_appreciation" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_token_decimals" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_token_supply" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "liquidity_pool_contribution" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ft_investment_reverse" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "off_assets_offered" SET NOT NULL`);
    }

}
