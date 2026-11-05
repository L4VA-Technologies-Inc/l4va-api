import { describe, expect, it } from "@jest/globals";

import {
  computeAllocation,
  computeNav,
  planBuys,
  planSells,
  validateWeights,
  type PlanOptions,
  type PortfolioState,
  type SkippedLeg,
} from "./index-rebalance.planner";

const ETH = 10n ** 18n;
const SPACEX = "0x00000000000000000000000000000000000000aa";
const NVDA = "0x00000000000000000000000000000000000000bb";
const OLD = "0x00000000000000000000000000000000000000cc";

const opts = (overrides: Partial<PlanOptions> = {}): PlanOptions => ({
  reserveBps: 1000,
  driftToleranceBps: 200,
  minTradeNative: ETH / 1000n,
  ...overrides,
});

describe("index rebalance planner", () => {
  describe("initial buy", () => {
    const state: PortfolioState = { nativeAvailable: 100n * ETH, holdings: [] };
    const targets = [
      { asset: SPACEX, weightBps: 6000 },
      { asset: NVDA, weightBps: 4000 },
    ];

    it("keeps the reserve in native and splits the rest by weight", () => {
      const buys = planBuys(state, targets, opts());
      expect(buys).toEqual([
        { asset: SPACEX, nativeIn: 54n * ETH },
        { asset: NVDA, nativeIn: 36n * ETH },
      ]);
    });

    it("plans no sells for an all-native vault", () => {
      expect(planSells(state, targets, opts())).toEqual([]);
    });
  });

  describe("re-weight", () => {
    // NAV 100: 10 native reserve, SPACEX 54, NVDA 36 — exactly on a 60/40 basket.
    const state: PortfolioState = {
      nativeAvailable: 10n * ETH,
      holdings: [
        { asset: SPACEX, balance: 540n, valueNative: 54n * ETH },
        { asset: NVDA, balance: 360n, valueNative: 36n * ETH },
      ],
    };

    it("trades nothing while every leg is inside the tolerance", () => {
      const targets = [
        { asset: SPACEX, weightBps: 6100 },
        { asset: NVDA, weightBps: 3900 },
      ];
      expect(planSells(state, targets, opts())).toEqual([]);
      expect(planBuys(state, targets, opts())).toEqual([]);
    });

    it("sells the overweight asset down to target in token units", () => {
      // SPACEX → 10%: target 9 ETH of value, excess 45 ETH = 5/6 of the balance.
      const targets = [
        { asset: SPACEX, weightBps: 1000 },
        { asset: NVDA, weightBps: 9000 },
      ];
      const sells = planSells(state, targets, opts());
      expect(sells).toEqual([
        { asset: SPACEX, amountIn: 450n, valueNative: 45n * ETH, exit: false },
      ]);
    });

    it("buys the underweight asset with the proceeds after sells settle", () => {
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
      expect(planBuys(afterSells, targets, opts())).toEqual([
        { asset: NVDA, nativeIn: 45n * ETH },
      ]);
    });

    it("exits an asset removed from the basket entirely", () => {
      const withOld: PortfolioState = {
        nativeAvailable: 10n * ETH,
        holdings: [
          ...state.holdings,
          { asset: OLD, balance: 777n, valueNative: 5n * ETH },
        ],
      };
      const sells = planSells(
        withOld,
        [
          { asset: SPACEX, weightBps: 6000 },
          { asset: NVDA, weightBps: 4000 },
        ],
        opts(),
      );
      expect(sells).toContainEqual({
        asset: OLD,
        amountIn: 777n,
        valueNative: 5n * ETH,
        exit: true,
      });
    });
  });

  it("scales buys pro rata when native cannot cover every deficit", () => {
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
      opts(),
    );
    const total = buys.reduce((s, b) => s + b.nativeIn, 0n);
    expect(total).toBeLessThanOrEqual(20n * ETH);
    expect(buys[0].nativeIn).toEqual(buys[1].nativeIn);
  });

  it("never spends the reserve", () => {
    const state: PortfolioState = { nativeAvailable: 5n * ETH, holdings: [] };
    const buys = planBuys(
      state,
      [{ asset: SPACEX, weightBps: 10000 }],
      opts({ reserveBps: 10000 }),
    );
    expect(buys).toEqual([]);
  });

  it("skips dust legs", () => {
    const state: PortfolioState = {
      nativeAvailable: ETH / 10_000n,
      holdings: [],
    };
    expect(
      planBuys(
        state,
        [{ asset: SPACEX, weightBps: 10000 }],
        opts({ reserveBps: 0 }),
      ),
    ).toEqual([]);
  });

  it("reports allocation against NAV including the reserve", () => {
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
      1000,
    );
    expect(nav).toEqual(computeNav(state));
    expect(reserveActualBps).toBe(1000);
    const spacex = rows.find((r) => r.asset === SPACEX)!;
    expect(spacex.targetBps).toBe(5400);
    expect(spacex.actualBps).toBe(6000);
    expect(spacex.driftBps).toBe(600);
  });

  describe("skipped legs (preview reasons)", () => {
    const L4VA = "0x0c020bef365d7001611ef1cecd6084cdd6b73683";
    const AMZN = "0x00000000000000000000000000000000000a3a2e";

    it("reports below_min_trade for a vault too small to trade (staging DTIV case)", () => {
      // NAV ≈ 0.00155 ETH: 89.9% L4VA, 10.1% ETH; new basket L4VA 90% / AMZN 10%, 10% reserve.
      const state: PortfolioState = {
        nativeAvailable: 156_666_666_666_666n,
        holdings: [
          {
            asset: L4VA,
            balance: 3_216n * ETH,
            valueNative: 1_393_400_015_384_646n,
          },
        ],
      };
      const targets = [
        { asset: L4VA, weightBps: 9000 },
        { asset: AMZN, weightBps: 1000 },
      ];
      const skipped: SkippedLeg[] = [];
      const o = opts({ reserveBps: 1000, driftToleranceBps: 200 });
      expect(planSells(state, targets, o, skipped)).toEqual([]);
      expect(planBuys(state, targets, o, skipped)).toEqual([]);
      expect(skipped.map((s) => [s.asset, s.side, s.reason])).toEqual([
        [L4VA, "sell", "below_min_trade"],
        [AMZN, "buy", "below_min_trade"],
      ]);
    });

    it("reports within_tolerance for small drift and no_free_native when the reserve blocks buys", () => {
      const state: PortfolioState = {
        nativeAvailable: ETH, // exactly the 10% reserve → nothing spendable
        holdings: [{ asset: SPACEX, balance: 9n * ETH, valueNative: 9n * ETH }],
      };
      const skipped: SkippedLeg[] = [];
      const o = opts({ reserveBps: 1000, driftToleranceBps: 200 });
      // SPACEX 9 ETH vs target 8.1 ETH: excess 0.9 > tolerance 0.2 → planned sell, not skipped.
      expect(
        planSells(
          state,
          [
            { asset: SPACEX, weightBps: 9000 },
            { asset: AMZN, weightBps: 1000 },
          ],
          o,
          skipped,
        ),
      ).toHaveLength(1);
      // Before that sell fills, AMZN (deficit 0.9 ETH) has no free native.
      expect(
        planBuys(
          state,
          [
            { asset: SPACEX, weightBps: 9000 },
            { asset: AMZN, weightBps: 1000 },
          ],
          o,
          skipped,
        ),
      ).toEqual([]);
      expect(skipped).toEqual([
        {
          asset: AMZN,
          side: "buy",
          reason: "no_free_native",
          valueNative: (9n * ETH) / 10n,
        },
      ]);

      const nearTarget: SkippedLeg[] = [];
      planSells(
        {
          nativeAvailable: ETH,
          holdings: [
            { asset: SPACEX, balance: 9n * ETH, valueNative: 9n * ETH },
          ],
        },
        [{ asset: SPACEX, weightBps: 10000 }],
        o,
        nearTarget,
      );
      // Target 9 ETH exactly → no excess at all, nothing reported.
      expect(nearTarget).toEqual([]);
    });
  });

  describe("validateWeights", () => {
    const base = { maxAssets: 10, minWeightBps: 100 };
    it("accepts a basket summing to 100%", () => {
      expect(
        validateWeights({ ...base, weightsBps: [5000, 3000, 2000] }),
      ).toBeNull();
    });
    it("rejects a basket that does not sum to 100%", () => {
      expect(validateWeights({ ...base, weightsBps: [5000, 3000] })).toMatch(
        /add up to 100%/,
      );
    });
    it("rejects too many assets", () => {
      expect(
        validateWeights({ ...base, weightsBps: Array(11).fill(909) }),
      ).toMatch(/at most 10/);
    });
    it("rejects weights below the minimum", () => {
      expect(validateWeights({ ...base, weightsBps: [9950, 50] })).toMatch(
        /at least 1%/,
      );
    });
  });
});
