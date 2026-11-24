import { afterEach, describe, expect, it } from '@jest/globals';

import { acquireExpansionIsFull } from './evm-acquire-signatures';

const ETH = 10n ** 18n;

describe('acquireExpansionIsFull', () => {
  afterEach(() => {
    delete process.env.EVM_MIN_ACQUIRE_WEI;
  });

  const max = 45_581n * 10n ** 12n; // 0.045581 ETH

  it('is full at or above the maximum', () => {
    expect(acquireExpansionIsFull(max, max)).toBe(true);
    expect(acquireExpansionIsFull(max + 1n, max)).toBe(true);
  });

  it('is full when less than one minimum acquire is left (USD→ETH rounding short of the max)', () => {
    // Stage: 0.045580557161369184 ETH raised against a 0.045581 ETH maximum.
    expect(acquireExpansionIsFull(45_580_557_161_369_184n, max)).toBe(true);
  });

  it('stays open while a minimum acquire still fits', () => {
    expect(acquireExpansionIsFull(max - ETH / 1000n, max)).toBe(false);
    expect(acquireExpansionIsFull(0n, max)).toBe(false);
  });

  it('follows EVM_MIN_ACQUIRE_WEI', () => {
    process.env.EVM_MIN_ACQUIRE_WEI = '1';
    expect(acquireExpansionIsFull(45_580_557_161_369_184n, max)).toBe(false);
  });

  it('is never full without a maximum', () => {
    expect(acquireExpansionIsFull(ETH, 0n)).toBe(false);
  });
});
