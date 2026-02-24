import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGovernanceFeesToSystemSettings1771859646075 implements MigrationInterface {
  name = 'AddGovernanceFeesToSystemSettings1771859646075';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add governance fee fields to system_settings JSONB data column
    await queryRunner.query(`
      UPDATE "system_settings"
      SET 
        data = data || jsonb_build_object(
          'governance_fee_proposal_staking', 5000000,
          'governance_fee_proposal_distribution', 5000000,
          'governance_fee_proposal_termination', 10000000,
          'governance_fee_proposal_burning', 3000000,
          'governance_fee_proposal_marketplace_action', 5000000,
          'governance_fee_proposal_expansion', 10000000,
          'governance_fee_voting', 0
        ),
        updated_at = NOW()
      WHERE id = '470ba027-d444-404d-a377-b41257d0efe7'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove governance fee fields from system_settings JSONB data column
    await queryRunner.query(`
      UPDATE "system_settings"
      SET 
        data = data - 'governance_fee_proposal_staking'
                    - 'governance_fee_proposal_distribution'
                    - 'governance_fee_proposal_termination'
                    - 'governance_fee_proposal_burning'
                    - 'governance_fee_proposal_marketplace_action'
                    - 'governance_fee_proposal_expansion'
                    - 'governance_fee_voting',
        updated_at = NOW()
      WHERE id = '470ba027-d444-404d-a377-b41257d0efe7'
    `);
  }
}
