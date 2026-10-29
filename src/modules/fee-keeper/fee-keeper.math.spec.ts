import { describe, expect, it, jest } from '@jest/globals';

import { applySlippage, chunk, isTransientError, randomConvertAmount, randomInt, withRetries } from './fee-keeper.math';

describe('fee-keeper math', () => {
  it('applySlippage rounds down and validates bps', () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
    expect(applySlippage(999n, 50)).toBe(994n);
    expect(applySlippage(123n, 0)).toBe(123n);
    expect(() => applySlippage(1n, -1)).toThrow();
    expect(() => applySlippage(1n, 10_001)).toThrow();
    expect(() => applySlippage(1n, 1.5)).toThrow();
  });

  it('chunk splits evenly and rejects bad sizes', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });

  it('isTransientError retries RPC hiccups but never reverts', () => {
    expect(isTransientError(new Error('request timed out'))).toBe(true);
    expect(isTransientError(new Error('HTTP 429 rate limit'))).toBe(true);
    expect(isTransientError(new Error('nonce too low'))).toBe(true);
    expect(isTransientError(new Error('execution reverted: FeeConverter: min out'))).toBe(false);
    expect(isTransientError(new Error('something else'))).toBe(false);
  });

  it('withRetries retries only retryable errors and rethrows the last one', async () => {
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new Error('timeout');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1, isRetryable: isTransientError, sleep }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error('execution reverted');
        },
        { retries: 3, baseDelayMs: 1, isRetryable: isTransientError, sleep }
      )
    ).rejects.toThrow('execution reverted');
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error('timeout');
        },
        { retries: 2, baseDelayMs: 1, isRetryable: isTransientError, sleep }
      )
    ).rejects.toThrow('timeout');
    expect(calls).toBe(3);
  });

  it('randomConvertAmount spends a random share within bounds', () => {
    // rng 0 → the minimum share, rng ~1 → everything available.
    expect(randomConvertAmount(1_000n, 3000, () => 0)).toBe(300n);
    expect(randomConvertAmount(1_000n, 3000, () => 0.999999)).toBe(1_000n);
    expect(randomConvertAmount(1n, 3000, () => 0)).toBe(1n);
    expect(randomConvertAmount(0n, 3000, () => 0.5)).toBe(0n);
  });

  it('randomInt stays within [min, max]', () => {
    expect(randomInt(60, 240, () => 0)).toBe(60);
    expect(randomInt(60, 240, () => 0.999999)).toBe(240);
  });
});
