import { describe, expect, it } from '@jest/globals';

import { chunkRelease, computeVtRelease } from './evm-lp-exit.formulas';

const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const C = '0x00000000000000000000000000000000000000cc';
const POOL = '0x00000000000000000000000000000000000000dd';

describe('computeVtRelease', () => {
  it('splits pro rata and releases the whole amount', () => {
    const plan = computeVtRelease(
      1000n,
      new Map([
        [A, 600n],
        [B, 300n],
        [C, 100n],
      ]),
      []
    );
    expect(plan.recipients).toEqual([A, B, C]);
    expect(plan.amounts).toEqual([600n, 300n, 100n]);
    expect(plan.total).toBe(1000n);
  });

  it('gives the rounding remainder to the largest holder', () => {
    const plan = computeVtRelease(
      10n,
      new Map([
        [A, 1n],
        [B, 1n],
        [C, 1n],
      ]),
      []
    );
    expect(plan.amounts.reduce((s, a) => s + a, 0n)).toBe(10n);
    expect(plan.amounts).toEqual([4n, 3n, 3n]);
  });

  it('skips excluded addresses case-insensitively', () => {
    const plan = computeVtRelease(
      90n,
      new Map([
        [A, 60n],
        [B, 30n],
        [POOL, 1000n],
      ]),
      [POOL.toUpperCase().replace('0X', '0x')]
    );
    expect(plan.recipients).toEqual([A, B]);
    expect(plan.amounts).toEqual([60n, 30n]);
  });

  it('keeps shares equal to burning the pool VT', () => {
    // S = 1,000 held + 250 from the pool. After release, A's share of S equals A's share of the 1,000.
    const plan = computeVtRelease(
      250n * 10n ** 18n,
      new Map([
        [A, 700n * 10n ** 18n],
        [B, 300n * 10n ** 18n],
      ]),
      []
    );
    const aFinal = 700n * 10n ** 18n + plan.amounts[0];
    expect((aFinal * 1000n) / (1250n * 10n ** 18n)).toBe(700n);
  });

  it('returns nothing to release for zero', () => {
    expect(computeVtRelease(0n, new Map([[A, 1n]]), []).recipients).toEqual([]);
  });

  it('refuses to release with no eligible holder', () => {
    expect(() => computeVtRelease(5n, new Map([[POOL, 1n]]), [POOL])).toThrow('No eligible VT holders');
  });
});

describe('chunkRelease', () => {
  it('chunks parallel arrays', () => {
    const plan = computeVtRelease(
      3n,
      new Map([
        [A, 1n],
        [B, 1n],
        [C, 1n],
      ]),
      []
    );
    const chunks = chunkRelease(plan, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].recipients).toHaveLength(2);
    expect(chunks[1].amounts).toEqual([1n]);
  });
});
