import { describe, expect, it } from '@jest/globals';

import {
  computeAllocation,
  computeNav,
  planBuys,
  planSells,
  validateWeights,
  type PlanOptions,
  type PortfolioState,
} from './index-rebalance.planner';

const ETH = 10n ** 18n;
const SPACEX = '0x00000000000000000000000000000000000000aa';
const NVDA = '0x00000000000000000000000000000000000000bb';
const OLD = '0x00000000000000000000000000000000000000cc';

const opts = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  reserveBps: 1000,
  driftToleranceBps: 200,
  minTradeNative: ETH / 1000n,
  ...overrides,
});

describe('index rebalance planner', () => {
  describe('initial buy', () => {
    const state: PortfolioState = { nativeAvailable: 100n * ETH, holdings: [] };
    const targets = [
      { asset: SPACEX, weightBps: 6000 },
      { asset: NVDA, weightBps: 4000 },
    ];

    it('keeps the reserve in native and splits the rest by weight', () => {
      const buys = planBuys(state, targets, opts());
      expect(buys).toEqual([
        { asset: SPACEX, nativeIn: 54n * ETH },
        { asset: NVDA, nativeIn: 36n * ETH },
      ]);
    });

    it('plans no sells for an all-native vault', () => {
      expect(planSells(state, targets, opts())).toEqual([]);
    });
  });

  describe('re-weight', () => {
    // NAV 100: 10 native reserve, SPACEX 54, NVDA 36 — exactly on a 60/40 basket.
    const state: PortfolioState = {
      nativeAvailable: 10n * ETH,
      holdings: [
        { asset: SPACEX, balance: 540n, valueNative: 54n * ETH },
        { asset: NVDA, balance: 360n, valueNative: 36n * ETH },
      ],
    };

    it('trades nothing while every leg is inside the tolerance', () => {
      const targets = [
        { asset: SPACEX, weightBps: 6100 },
        { asset: NVDA, weightBps: 3900 },
      ];
      expect(planSells(state, targets, opts())).toEqual([]);
      expect(planBuys(state, targets, opts())).toEqual([]);
    });

    it('sells the overweight asset down to target in token units', () => {
      // SPACEX → 10%: target 9 ETH of value, excess 45 ETH = 5/6 of the balance.
      const targets = [
        { asset: SPACEX, weightBps: 1000 },
        { asset: NVDA, weightBps: 9000 },
      ];
      const sells = planSells(state, targets, opts());
      expect(sells).toEqual([{ asset: SPACEX, amountIn: 450n, valueNative: 45n * ETH, exit: false }]);
    });

    it('buys the underweight asset with the proceeds after sells settle', () => {
      const targets = [
        { asset: SPACEX, weightBps: 1000 },
        { asset: NVDA, weightBps: 9000 },
      ];
      const afterSells: PortfolioState = {
        nativeAvailable: 55n * ETH,
        holdings: [
          { asset: SPACEX, balance: 90n, valueNative: 9n * ETH },
          { asset: NVDA, balance: 360n, valueNative: 36n * ETH },
        ],
      };
      expect(planBuys(afterSells, targets, opts())).toEqual([{ asset: NVDA, nativeIn: 45n * ETH }]);
    });

    it('exits an asset removed from the basket entirely', () => {
      const withOld: PortfolioState = {
        nativeAvailable: 10n * ETH,
        holdings: [...state.holdings, { asset: OLD, balance: 777n, valueNative: 5n * ETH }],
      };
      const sells = planSells(
        withOld,
        [
          { asset: SPACEX, weightBps: 6000 },
          { asset: NVDA, weightBps: 4000 },
        ],
        opts()
      );
      expect(sells).toContainEqual({ asset: OLD, amountIn: 777n, valueNative: 5n * ETH, exit: true });
    });
  });

  it('scales buys pro rata when native cannot cover every deficit', () => {
    // Sells failed to fill: only 20 ETH spendable for 45 + 9 of deficits.
    const state: PortfolioState = {
      nativeAvailable: 30n * ETH,
      holdings: [{ asset: OLD, balance: 1n, valueNative: 70n * ETH }],
    };
    const buys = planBuys(
      state,
      [
        { asset: SPACEX, weightBps: 5000 },
        { asset: NVDA, weightBps: 5000 },
      ],
      opts()
    );
    const total = buys.reduce((s, b) => s + b.nativeIn, 0n);
    expect(total).toBeLessThanOrEqual(20n * ETH);
    expect(buys[0].nativeIn).toEqual(buys[1].nativeIn);
  });

  it('never spends the reserve', () => {
    const state: PortfolioState = { nativeAvailable: 5n * ETH, holdings: [] };
    const buys = planBuys(state, [{ asset: SPACEX, weightBps: 10000 }], opts({ reserveBps: 10000 }));
    expect(buys).toEqual([]);
  });

  it('skips dust legs', () => {
    const state: PortfolioState = { nativeAvailable: ETH / 10_000n, holdings: [] };
    expect(planBuys(state, [{ asset: SPACEX, weightBps: 10000 }], opts({ reserveBps: 0 }))).toEqual([]);
  });

  it('reports allocation against NAV including the reserve', () => {
    const state: PortfolioState = {
      nativeAvailable: 10n * ETH,
      holdings: [
        { asset: SPACEX, balance: 1n, valueNative: 60n * ETH },
        { asset: NVDA, balance: 1n, valueNative: 30n * ETH },
      ],
    };
    const { nav, rows, reserveActualBps } = computeAllocation(
      state,
      [
        { asset: SPACEX, weightBps: 6000 },
        { asset: NVDA, weightBps: 4000 },
      ],
      1000
    );
    expect(nav).toEqual(computeNav(state));
    expect(reserveActualBps).toBe(1000);
    const spacex = rows.find(r => r.asset === SPACEX)!;
    expect(spacex.targetBps).toBe(5400);
    expect(spacex.actualBps).toBe(6000);
    expect(spacex.driftBps).toBe(600);
  });

  describe('validateWeights', () => {
    const base = { maxAssets: 10, minWeightBps: 100 };
    it('accepts a basket summing to 100%', () => {
      expect(validateWeights({ ...base, weightsBps: [5000, 3000, 2000] })).toBeNull();
    });
    it('rejects a basket that does not sum to 100%', () => {
      expect(validateWeights({ ...base, weightsBps: [5000, 3000] })).toMatch(/add up to 100%/);
    });
    it('rejects too many assets', () => {
      expect(validateWeights({ ...base, weightsBps: Array(11).fill(909) })).toMatch(/at most 10/);
    });
    it('rejects weights below the minimum', () => {
      expect(validateWeights({ ...base, weightsBps: [9950, 50] })).toMatch(/at least 1%/);
    });
  });
});
