import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds `vault_spec_overrides` in system settings with the per-chain vault creation parameters
 * the AI assistant, the create endpoint and the client form all read. The values equal the
 * current spec, so nothing changes on deploy; from then on they are edited here (save + reload).
 *
 * Durations are left out on purpose: they come from MIN_*_DURATION_MS env (short windows on
 * staging), and a value here would override that.
 */
const VAULT_SPEC_OVERRIDES = {
  all: {
    creationThreshold: { max: 100 },
    cosigningThreshold: { min: 33, max: 100 },
    executionThreshold: { min: 50.1, max: 100 },
  },
  cardano: {
    liquidityPoolContribution: { min: 0, max: 100 },
    creationThreshold: { min: 0.5 },
    minAcquireThreshold: { min: 1, max: 100000, disabled: false },
    allowAcquireExpansion: { default: false, disabled: false },
  },
  robinhood: {
    liquidityPoolContribution: { min: 5, max: 20, default: 10 },
    creationThreshold: { min: 0.1, default: 0.1 },
    // Range stays in evm_min/max_acquire_threshold_eth; a min/max here would override those.
    minAcquireThreshold: {
      requiredIf: [{ field: 'isAcquireOnly', equals: true }],
      disabled: false,
    },
    allowAcquireExpansion: { default: true, disabled: false },
  },
};

export class AddVaultSpecOverridesToSystemSettings1795600000000 implements MigrationInterface {
  name = 'AddVaultSpecOverridesToSystemSettings1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Only where the key is missing: never overwrite values already edited in the admin.
    await queryRunner.query(
      `UPDATE "system_settings"
       SET data = data || jsonb_build_object('vault_spec_overrides', $1::jsonb), updated_at = NOW()
       WHERE NOT (data ? 'vault_spec_overrides')`,
      [JSON.stringify(VAULT_SPEC_OVERRIDES)]
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "system_settings" SET data = data - 'vault_spec_overrides', updated_at = NOW()`);
  }
}
