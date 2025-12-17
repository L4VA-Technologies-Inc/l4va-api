import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConsolidateProposalMetadataAndAddMarketplaceAction1765966368473 implements MigrationInterface {
  name = 'ConsolidateProposalMetadataAndAddMarketplaceAction1765966368473';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb"`);
    await queryRunner.query(`ALTER TABLE "vault_tags" DROP CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc"`);

    // Add metadata column first
    await queryRunner.query(`ALTER TABLE "proposal" ADD "metadata" jsonb`);

    // Migrate existing data to metadata column
    await queryRunner.query(`
      UPDATE "proposal" 
      SET "metadata" = jsonb_build_object(
        'fungibleTokens', COALESCE("fungible_tokens", '[]'::json),
        'nonFungibleTokens', COALESCE("non_fungible_tokens", '[]'::json),
        'distributionAssets', COALESCE("distribution_assets", '[]'::json),
        'burnAssets', COALESCE("burn_assets", '[]'::json),
        'buyingSellingOptions', COALESCE("buying_selling_options", '[]'::json),
      )
      WHERE "fungible_tokens" IS NOT NULL 
         OR "non_fungible_tokens" IS NOT NULL
         OR "distribution_assets" IS NOT NULL
         OR "burn_assets" IS NOT NULL
         OR "buying_selling_options" IS NOT NULL
         OR "termination_reason" IS NOT NULL
    `);

    // Now drop the old columns
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "fungible_tokens"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "non_fungible_tokens"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "distribution_assets"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "burn_assets"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "buying_selling_options"`);
    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "termination_reason"`);

    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" SET DEFAULT null`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" SET DEFAULT null`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum" RENAME TO "proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell', 'marketplace_action')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum_old"`);
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
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_proposal_type_enum_old" AS ENUM('staking', 'distribution', 'termination', 'burning', 'buy_sell')`
    );
    await queryRunner.query(
      `ALTER TABLE "proposal" ALTER COLUMN "proposal_type" TYPE "public"."proposal_proposal_type_enum_old" USING "proposal_type"::"text"::"public"."proposal_proposal_type_enum_old"`
    );
    await queryRunner.query(`DROP TYPE "public"."proposal_proposal_type_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."proposal_proposal_type_enum_old" RENAME TO "proposal_proposal_type_enum"`
    );
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "dispatch_preloaded_script" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "apply_params_result" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "ada_distribution" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "vaults" ALTER COLUMN "acquire_multiplier" DROP DEFAULT`);

    // Restore old columns
    await queryRunner.query(`ALTER TABLE "proposal" ADD "termination_reason" text`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "buying_selling_options" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "burn_assets" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "distribution_assets" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "non_fungible_tokens" json`);
    await queryRunner.query(`ALTER TABLE "proposal" ADD "fungible_tokens" json`);

    // Migrate data back from metadata
    await queryRunner.query(`
      UPDATE "proposal"
      SET 
        "fungible_tokens" = ("metadata"->>'fungibleTokens')::json,
        "non_fungible_tokens" = ("metadata"->>'nonFungibleTokens')::json,
        "distribution_assets" = ("metadata"->>'distributionAssets')::json,
        "burn_assets" = ("metadata"->>'burnAssets')::json,
        "buying_selling_options" = ("metadata"->>'buyingSellingOptions')::json,
        "termination_reason" = "metadata"->>'terminationReason'
      WHERE "metadata" IS NOT NULL
    `);

    await queryRunner.query(`ALTER TABLE "proposal" DROP COLUMN "metadata"`);

    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_2b3fd4667b2be7a2d7a329083cc" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE`
    );
    await queryRunner.query(
      `ALTER TABLE "vault_tags" ADD CONSTRAINT "FK_adf9f0b047319be1ec67ac1d1eb" FOREIGN KEY ("vault_id") REFERENCES "vaults"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
    );
  }
}
