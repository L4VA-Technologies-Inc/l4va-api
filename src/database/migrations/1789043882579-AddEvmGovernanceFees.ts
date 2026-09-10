import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds wei-denominated governance fee settings for EVM (Robinhood) vaults.
 *
 * Values are decimal STRINGS, not numbers: wei exceeds Number.MAX_SAFE_INTEGER
 * and jsonb numerics would round. All seeded to '0' so the EVM fee flow ships
 * dark — an admin enables it per proposal type without a redeploy.
 */
export class AddEvmGovernanceFees1789043882579 implements MigrationInterface {
  name = 'AddEvmGovernanceFees1789043882579';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "system_settings"
      SET
        data = data || jsonb_build_object(
          'governance_fee_proposal_staking_evm', '0',
          'governance_fee_proposal_distribution_evm', '0',
          'governance_fee_proposal_termination_evm', '0',
          'governance_fee_proposal_burning_evm', '0',
          'governance_fee_proposal_marketplace_action_evm', '0',
          'governance_fee_proposal_expansion_evm', '0',
          'governance_fee_proposal_asset_whitelist_update_evm', '0',
          'governance_fee_voting_evm', '0'
        ),
        updated_at = NOW()
      WHERE id = '470ba027-d444-404d-a377-b41257d0efe7'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "system_settings"
      SET
        data = data - 'governance_fee_proposal_staking_evm'
                    - 'governance_fee_proposal_distribution_evm'
                    - 'governance_fee_proposal_termination_evm'
                    - 'governance_fee_proposal_burning_evm'
                    - 'governance_fee_proposal_marketplace_action_evm'
                    - 'governance_fee_proposal_expansion_evm'
                    - 'governance_fee_proposal_asset_whitelist_update_evm'
                    - 'governance_fee_voting_evm',
        updated_at = NOW()
      WHERE id = '470ba027-d444-404d-a377-b41257d0efe7'
    `);
  }
}
