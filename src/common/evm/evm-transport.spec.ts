import { describe, expect, it } from '@jest/globals';

import { isRpcRateLimitError } from './evm-transport';

describe('isRpcRateLimitError', () => {
  it('detects node rate limits in messages, details, status and causes', () => {
    expect(isRpcRateLimitError(new Error('RPC Request failed.\n\nDetails: Too Many Requests'))).toBe(true);
    expect(isRpcRateLimitError(new Error('Request exceeds defined limit.'))).toBe(true);
    expect(isRpcRateLimitError({ message: 'x', details: 'too many concurrent requests' })).toBe(true);
    expect(isRpcRateLimitError({ message: 'HTTP request failed', status: 429 })).toBe(true);
    expect(isRpcRateLimitError({ message: 'swap failed', cause: { status: 429 } })).toBe(true);
    expect(isRpcRateLimitError('action[2]: swap failed — RPC Request failed. Details: Too Many Requests')).toBe(true);
  });

  it('does not match contract reverts or other failures', () => {
    expect(isRpcRateLimitError(new Error('swap simulation reverted: The contract function "swap" reverted.'))).toBe(
      false
    );
    expect(isRpcRateLimitError(new Error('DailyCapExceeded(vault, asset, 2529, 632)'))).toBe(false);
    expect(isRpcRateLimitError(null)).toBe(false);
  });
});
