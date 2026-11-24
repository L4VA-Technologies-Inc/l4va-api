import { describe, expect, it } from '@jest/globals';

import {
  findSpecBoundsViolations,
  resolveVaultCreationSpec,
  resolveVaultCreationSpecFromSettings,
  VaultSpecSettings,
} from './resolve-spec';

import { VaultArchetype } from '@/types/index-vault.types';
import { ChainType } from '@/types/vault.types';

// The client form validates against these resolved bounds (GET /ai/vault-creation-spec),
// so a change here changes what both the assistant and the form accept.
describe('resolveVaultCreationSpec', () => {
  it('keeps Robinhood LP contribution in the 5–20% launch range for every archetype', () => {
    for (const archetype of [VaultArchetype.standard, VaultArchetype.index_weighted]) {
      const lp = resolveVaultCreationSpec(ChainType.robinhood, 'mainnet', archetype).fields.liquidityPoolContribution;
      expect(lp).toMatchObject({ min: 5, max: 20, default: 10 });
    }
  });

  it('leaves Cardano LP contribution at 0–100%', () => {
    const lp = resolveVaultCreationSpec(ChainType.cardano, 'mainnet').fields.liquidityPoolContribution;
    expect(lp).toMatchObject({ min: 0, max: 100 });
  });
});

const settings = (overrides: Partial<VaultSpecSettings> = {}): VaultSpecSettings => ({
  specNetwork: 'preprod',
  minContributionDuration: 600_000,
  maxContributionDuration: 30 * 86_400_000,
  minAcquireWindowDuration: 300_000,
  maxAcquireWindowDuration: 7 * 86_400_000,
  minAcquireThresholdEth: 0.1,
  maxAcquireThresholdEth: 1_000,
  vaultArchetypesEnabled: () => [VaultArchetype.index_weighted],
  ...overrides,
});

describe('resolveVaultCreationSpecFromSettings', () => {
  it('applies system settings (and the env vars behind them) over the static spec', () => {
    const spec = resolveVaultCreationSpecFromSettings(
      settings({ minContributionDuration: 120_000, maxAcquireWindowDuration: 3 * 86_400_000 }),
      ChainType.robinhood
    );
    expect(spec.network).toBe('preprod');
    expect(spec.archetype).toBe(VaultArchetype.index_weighted);
    expect(spec.fields.contributionDuration).toMatchObject({ min: 120_000, max: 30 * 86_400_000 });
    expect(spec.fields.acquireWindowDuration).toMatchObject({ min: 300_000, max: 3 * 86_400_000 });
    expect(spec.fields.minAcquireThreshold).toMatchObject({ min: 0.1, max: 1_000 });
  });

  it('does not put ETH threshold bounds on Cardano', () => {
    const spec = resolveVaultCreationSpecFromSettings(settings(), ChainType.cardano);
    expect(spec.fields.minAcquireThreshold.unit).toBe('ADA');
    expect(spec.fields.minAcquireThreshold.max).toBeUndefined();
  });
});

describe('findSpecBoundsViolations', () => {
  const spec = resolveVaultCreationSpecFromSettings(settings(), ChainType.robinhood);

  it('reports values outside the spec range with readable bounds', () => {
    const violations = findSpecBoundsViolations(
      spec,
      { liquidityPoolContribution: 0, acquireWindowDuration: 8 * 86_400_000, creationThreshold: 0.1 },
      { liquidityPoolContribution: 'LP', acquireWindowDuration: 'Acquire window', creationThreshold: 'Threshold' }
    );
    expect(violations).toEqual([
      { field: 'liquidityPoolContribution', message: 'LP must be between 5% and 20%' },
      { field: 'acquireWindowDuration', message: 'Acquire window must be between 5 minute(s) and 7 day(s)' },
    ]);
  });

  it('skips absent values', () => {
    expect(findSpecBoundsViolations(spec, {}, { liquidityPoolContribution: 'LP' })).toEqual([]);
  });
});
