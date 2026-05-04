import { MigrationInterface, QueryRunner } from 'typeorm';

export class ChangeAssetCountCapsToBigint1777939200123 implements MigrationInterface {
  name = 'ChangeAssetCountCapsToBigint1777939200123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Change asset_count_cap_min from integer to bigint
    await queryRunner.query(
      `ALTER TABLE "assets_whitelist" ALTER COLUMN "asset_count_cap_min" TYPE bigint USING "asset_count_cap_min"::bigint`
    );

    // Change asset_count_cap_max from integer to bigint
    await queryRunner.query(
      `ALTER TABLE "assets_whitelist" ALTER COLUMN "asset_count_cap_max" TYPE bigint USING "asset_count_cap_max"::bigint`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert asset_count_cap_max back to integer
    // Note: This will fail if values exceed integer max (2,147,483,647)
    await queryRunner.query(
      `ALTER TABLE "assets_whitelist" ALTER COLUMN "asset_count_cap_max" TYPE integer USING "asset_count_cap_max"::integer`
    );

    // Revert asset_count_cap_min back to integer
    // Note: This will fail if values exceed integer max (2,147,483,647)
    await queryRunner.query(
      `ALTER TABLE "assets_whitelist" ALTER COLUMN "asset_count_cap_min" TYPE integer USING "asset_count_cap_min"::integer`
    );
  }
}
