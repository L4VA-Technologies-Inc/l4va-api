import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One user per wallet per chain: the same EVM address on Robinhood and Arc is two users,
 * linked by a shared verified email like Cardano and Robinhood wallets.
 */
export class UsersUniqueAddressPerChain1789700000000 implements MigrationInterface {
  name = 'UsersUniqueAddressPerChain1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "UQ_b0ec0293d53a1385955f9834d5c"`);
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_users_address_chain" ON "users" ("address", "chain_type")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fails if a wallet already has users on several chains — remove the extra rows first.
    await queryRunner.query(`DROP INDEX "public"."IDX_users_address_chain"`);
    await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_b0ec0293d53a1385955f9834d5c" UNIQUE ("address")`);
  }
}
