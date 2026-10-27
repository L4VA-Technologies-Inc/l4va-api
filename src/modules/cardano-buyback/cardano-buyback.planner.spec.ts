import { describe, expect, it } from '@jest/globals';

import {
  baseToDisplay,
  checkQuote,
  DEFAULT_SPLIT,
  displayToBase,
  planDistribution,
  planSwapAmount,
  splitL4va,
  validateSplit,
  type QuoteCheckInput,
  type SwapSizing,
} from './cardano-buyback.planner';

const ADA = 1_000_000n;
const L4VA = 1_000_000n; // 6 decimals

describe('cardano buyback planner', () => {
  describe('splitL4va', () => {
    it('splits 25 / 25 / 50 by default', () => {
      expect(splitL4va(1_000n * L4VA)).toEqual({ burn: 250n * L4VA, treasury: 250n * L4VA, ops: 500n * L4VA });
    });

    it('gives rounding dust to ops and never loses a unit', () => {
      const split = splitL4va(7n);
      expect(split).toEqual({ burn: 1n, treasury: 1n, ops: 5n });
      expect(split.burn + split.treasury + split.ops).toBe(7n);
    });

    it('conserves the total for odd amounts and custom splits', () => {
      for (const amount of [1n, 3n, 999_999n, 123_456_789_012n]) {
        const split = splitL4va(amount, { burnBps: 3_333n, treasuryBps: 1_111n });
        expect(split.burn + split.treasury + split.ops).toBe(amount);
        expect(split.ops >= 0n).toBe(true);
      }
    });

    it('handles 100% burn', () => {
      expect(splitL4va(10n, { burnBps: 10_000n, treasuryBps: 0n })).toEqual({ burn: 10n, treasury: 0n, ops: 0n });
    });

    it('rejects negative amounts', () => {
      expect(() => splitL4va(-1n)).toThrow('non-negative');
    });
  });

  describe('validateSplit', () => {
    it('accepts the default', () => {
      expect(() => validateSplit(DEFAULT_SPLIT)).not.toThrow();
    });

    it('rejects shares over 100%', () => {
      expect(() => validateSplit({ burnBps: 6_000n, treasuryBps: 5_000n })).toThrow('exceeds 100%');
    });

    it('rejects negative shares', () => {
      expect(() => validateSplit({ burnBps: -1n, treasuryBps: 0n })).toThrow('non-negative');
    });
  });

  describe('planDistribution', () => {
    it('returns null below the minimum', () => {
      expect(planDistribution(L4VA - 1n, L4VA)).toBeNull();
    });

    it('returns null for an empty wallet even with a zero minimum', () => {
      expect(planDistribution(0n, 0n)).toBeNull();
    });

    it('splits the whole balance at or above the minimum', () => {
      expect(planDistribution(4n * L4VA, L4VA)).toEqual({ burn: L4VA, treasury: L4VA, ops: 2n * L4VA });
    });
  });

  describe('planSwapAmount', () => {
    const sizing = (overrides: Partial<SwapSizing> = {}): SwapSizing => ({
      lovelaceBalance: 100n * ADA,
      reserveLovelace: 10n * ADA,
      minSwapLovelace: 50n * ADA,
      maxSwapLovelace: 1_000n * ADA,
      ...overrides,
    });

    it('swaps everything above the reserve', () => {
      expect(planSwapAmount(sizing())).toBe(90n * ADA);
    });

    it('caps at the per-execution maximum', () => {
      expect(planSwapAmount(sizing({ lovelaceBalance: 5_000n * ADA }))).toBe(1_000n * ADA);
    });

    it('returns null when the spendable balance is below the minimum', () => {
      expect(planSwapAmount(sizing({ lovelaceBalance: 59n * ADA }))).toBeNull();
    });

    it('returns null when the balance does not cover the reserve', () => {
      expect(planSwapAmount(sizing({ lovelaceBalance: 5n * ADA, minSwapLovelace: 0n }))).toBeNull();
    });

    it('swaps exactly the minimum at the boundary', () => {
      expect(planSwapAmount(sizing({ lovelaceBalance: 60n * ADA }))).toBe(50n * ADA);
    });

    it('rejects inconsistent bounds', () => {
      expect(() => planSwapAmount(sizing({ minSwapLovelace: 2_000n * ADA }))).toThrow('exceeds');
      expect(() => planSwapAmount(sizing({ maxSwapLovelace: 0n }))).toThrow('positive');
    });
  });

  describe('checkQuote', () => {
    const quote = (overrides: Partial<QuoteCheckInput> = {}): QuoteCheckInput => ({
      lovelaceIn: 100n * ADA,
      minOut: 5_000n * L4VA, // 50 L4VA per ADA
      priceImpactsPct: [0.4, 1.2],
      maxPriceImpactBps: 300n,
      minL4vaPerAda: 0n,
      ...overrides,
    });

    it('accepts a quote inside all guards', () => {
      expect(checkQuote(quote())).toEqual({ ok: true });
    });

    it('rejects a zero-output quote', () => {
      expect(checkQuote(quote({ minOut: 0n }))).toMatchObject({ ok: false });
    });

    it('rejects a non-positive input', () => {
      expect(checkQuote(quote({ lovelaceIn: 0n }))).toMatchObject({ ok: false });
    });

    it('rejects when any split exceeds the price impact cap', () => {
      const result = checkQuote(quote({ priceImpactsPct: [0.1, 3.01] }));
      expect(result).toMatchObject({ ok: false });
      if (result.ok === false) expect(result.reason).toContain('Price impact');
    });

    it('accepts price impact exactly at the cap', () => {
      expect(checkQuote(quote({ priceImpactsPct: [3] }))).toEqual({ ok: true });
    });

    it('ignores non-finite impacts and passes with no splits', () => {
      expect(checkQuote(quote({ priceImpactsPct: [NaN] }))).toEqual({ ok: true });
      expect(checkQuote(quote({ priceImpactsPct: [] }))).toEqual({ ok: true });
    });

    it('enforces the price floor', () => {
      expect(checkQuote(quote({ minL4vaPerAda: 50n * L4VA }))).toEqual({ ok: true });
      const result = checkQuote(quote({ minL4vaPerAda: 50n * L4VA + 1n }));
      expect(result).toMatchObject({ ok: false });
      if (result.ok === false) expect(result.reason).toContain('below floor');
    });

    it('applies the floor to fractional ADA inputs', () => {
      // 1.5 ADA → 75 L4VA is exactly 50 L4VA/ADA.
      expect(checkQuote(quote({ lovelaceIn: 1_500_000n, minOut: 75n * L4VA, minL4vaPerAda: 50n * L4VA }))).toEqual({
        ok: true,
      });
      expect(
        checkQuote(quote({ lovelaceIn: 1_500_000n, minOut: 75n * L4VA - 1n, minL4vaPerAda: 50n * L4VA }))
      ).toMatchObject({ ok: false });
    });
  });

  describe('unit conversion', () => {
    it('converts display amounts to base units', () => {
      expect(displayToBase(12.5, 6)).toBe(12_500_000n);
      expect(displayToBase('0.000001', 6)).toBe(1n);
      expect(displayToBase(0, 6)).toBe(0n);
      expect(displayToBase(42, 0)).toBe(42n);
    });

    it('truncates precision finer than decimals', () => {
      expect(displayToBase(1.0000009, 6)).toBe(1_000_000n);
    });

    it('does not pick up float noise', () => {
      // 0.1 + 0.2 = 0.30000000000000004
      expect(displayToBase(0.1 + 0.2, 6)).toBe(300_000n);
    });

    it('rejects invalid display amounts', () => {
      expect(() => displayToBase(-1, 6)).toThrow('Invalid');
      expect(() => displayToBase('abc', 6)).toThrow('Invalid');
    });

    it('converts base units to display amounts', () => {
      expect(baseToDisplay(90_000_000n, 6)).toBe(90);
      expect(baseToDisplay(1_500_001n, 6)).toBe(1.500001);
      expect(baseToDisplay(7n, 0)).toBe(7);
    });

    it('round-trips lovelace', () => {
      for (const lovelace of [1n, 999_999n, 1_000_000n, 123_456_789n]) {
        expect(displayToBase(baseToDisplay(lovelace, 6), 6)).toBe(lovelace);
      }
    });
  });
});
