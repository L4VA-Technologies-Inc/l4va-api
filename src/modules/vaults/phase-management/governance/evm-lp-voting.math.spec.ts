import { describe, expect, it } from '@jest/globals';

import { amountsForLiquidity, sqrtPriceAtTick } from './evm-lp-voting.math';
import { totalVotingPower, votingBalances } from './voting-power.util';

const Q96 = 2n ** 96n;

describe('LP voting math', () => {
  it('matches Uniswap TickMath reference values', () => {
    expect(sqrtPriceAtTick(0)).toBe(Q96);
    expect(sqrtPriceAtTick(-887272)).toBe(4295128739n); // MIN_SQRT_PRICE
    expect(sqrtPriceAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n); // MAX_SQRT_PRICE
  });

  it('puts an out-of-range position entirely in one token', () => {
    const [a, b] = [sqrtPriceAtTick(-600), sqrtPriceAtTick(600)];
    const L = 10n ** 18n;
    expect(amountsForLiquidity(L, sqrtPriceAtTick(-1200), a, b).amount1).toBe(0n);
    expect(amountsForLiquidity(L, sqrtPriceAtTick(1200), a, b).amount0).toBe(0n);
  });

  it('splits a symmetric in-range position evenly at price 1', () => {
    const { amount0, amount1 } = amountsForLiquidity(10n ** 18n, Q96, sqrtPriceAtTick(-600), sqrtPriceAtTick(600));
    expect(amount0 - amount1 < 2n && amount1 - amount0 < 2n).toBe(true);
  });
});

describe('votingBalances', () => {
  it('adds LP-attributed VT to held VT, case-insensitively', () => {
    const snapshot = {
      addressBalances: { '0xabc': '100', '0xdef': '50' },
      lpBalances: { '0xABC': '30', '0x123': '20' },
    };
    const weights = votingBalances(snapshot);
    expect(weights.get('0xabc')).toBe(130n);
    expect(weights.get('0x123')).toBe(20n);
    expect(totalVotingPower(snapshot)).toBe(200n);
  });

  it('ignores a missing lpBalances (Cardano snapshots)', () => {
    expect(totalVotingPower({ addressBalances: { a: '7' }, lpBalances: null })).toBe(7n);
  });
});
