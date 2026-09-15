import { describe, expect, it, jest } from '@jest/globals';

import { applySlippage, buybackPriceFloor, chunk, isTransientError, withRetries } from './fee-keeper.math';

describe('fee-keeper math', () => {
  it('applySlippage rounds down and validates bps', () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
    expect(applySlippage(999n, 50)).toBe(994n);
    expect(applySlippage(123n, 0)).toBe(123n);
    expect(() => applySlippage(1n, -1)).toThrow();
    expect(() => applySlippage(1n, 10_001)).toThrow();
    expect(() => applySlippage(1n, 1.5)).toThrow();
  });

  it('buybackPriceFloor mirrors BuybackExecutor._validateAmounts', () => {
    // 220 feeToken (18 dec) at 50 L4VA/feeToken with 1% max slippage.
    expect(buybackPriceFloor(220n * 10n ** 18n, 50n * 10n ** 18n, 100n)).toBe(10_890n * 10n ** 18n);
    // 6-decimal feeToken: 100 USDG at rate 50e30 (raw-unit scaled) → 5000 L4VA.
    expect(buybackPriceFloor(100_000_000n, 50n * 10n ** 30n, 0n)).toBe(5_000n * 10n ** 18n);
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
});
