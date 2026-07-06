import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAnvilApiCache1783089338525 implements MigrationInterface {
  name = 'CreateAnvilApiCache1783089338525';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "anvil_api_cache" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "endpoint" character varying(255) NOT NULL,
        "request_payload" jsonb,
        "response_data" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_anvil_api_cache_id" PRIMARY KEY ("id")
      )`
    );

    // Create composite index for cache lookups
    await queryRunner.query(
      `CREATE INDEX "IDX_anvil_api_cache_endpoint_payload" ON "anvil_api_cache" ("endpoint", "request_payload")`
    );

    // Create index for expiration cleanup
    await queryRunner.query(`CREATE INDEX "IDX_anvil_api_cache_expires_at" ON "anvil_api_cache" ("expires_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_anvil_api_cache_expires_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_anvil_api_cache_endpoint_payload"`);
    await queryRunner.query(`DROP TABLE "anvil_api_cache"`);
  }
}
