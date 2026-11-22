import { describe, expect, it } from '@jest/globals';

import { computeTerminationRates, validateTerminationRates } from './evm-termination.formulas';

const supply = 10n ** 24n;
const assets = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    asset: `0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`,
    free: 10n ** 18n,
  }));

describe('validateTerminationRates: per-vault asset cap', () => {
  it('accepts exactly the cap and rejects one over (legacy 16)', () => {
    expect(validateTerminationRates(computeTerminationRates(assets(16), supply).rows, 16)).toEqual([]);
    const errs = validateTerminationRates(computeTerminationRates(assets(17), supply).rows, 16);
    expect(errs.map(e => e.reason)).toContain('17 assets exceeds MAX_TERMINATION_ASSETS (16)');
  });

  it('a raised cap (56) accepts what the legacy one rejects', () => {
    expect(validateTerminationRates(computeTerminationRates(assets(56), supply).rows, 56)).toEqual([]);
    expect(validateTerminationRates(computeTerminationRates(assets(57), supply).rows, 56)).toHaveLength(1);
  });
});
