import { describe, expect, it } from '@jest/globals';
import { decodeAbiParameters, type Address } from 'viem';

import * as amznToEth from './__fixtures__/amzn-to-eth.v4-v3.json';
import * as cbbtcToEth from './__fixtures__/cbbtc-to-eth.3-paths.json';
import * as ethToAmzn from './__fixtures__/eth-to-amzn.v3-v4.json';
import * as ethToTslaon from './__fixtures__/eth-to-tslaon.v4-v4.json';
import {
  encodeMultiPathRoute,
  NATIVE,
  NoSupportedRouteError,
  pathSharesBps,
  planFromTradingApi,
  RouteVenue,
  v4PoolId,
  validateRoutePlan,
  type TradingApiHop,
  type TradingApiQuoteResponse,
} from './multi-path-route';

// Recorded from the Uniswap Trading API on Robinhood Chain 4663 (2026-11-09),
// requested with protocols [V3, V4] and hooksOptions V4_NO_HOOKS.

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c' as Address;
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54' as Address;
const CBBTC = '0xcec185eb182c47d1ba1efc84e6959e18cd620be4' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const TSLAON = '0xb197f36c25ba9b66960688882a4dc595c6b04309' as Address;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const PATHS_ABI = [
  {
    type: 'tuple[]',
    components: [
      { name: 'shareBps', type: 'uint16' },
      {
        name: 'hops',
        type: 'tuple[]',
        components: [
          { name: 'venue', type: 'uint8' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
        ],
      },
    ],
  },
] as const;

function decodeRoute(route: `0x${string}`) {
  const [kind, data] = decodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], route);
  const [paths] = decodeAbiParameters(PATHS_ABI, data);
  return { kind, paths };
}

describe('planFromTradingApi', () => {
  it('ETH → AMZN: v3 WETH/SPY then v4 SPY/AMZN (the route that failed on 2026-11-09)', () => {
    const plan = planFromTradingApi(ethToAmzn as TradingApiQuoteResponse, NATIVE, AMZN, 3577141523813693n, WETH);
    expect(plan.amountOut).toBe(28272311818779078n);
    expect(plan.paths).toHaveLength(1);
    expect(plan.paths[0].hops).toEqual([
      { venue: RouteVenue.v3, tokenIn: WETH, tokenOut: SPY, fee: 500, tickSpacing: 0 },
      { venue: RouteVenue.v4, tokenIn: SPY, tokenOut: AMZN, fee: 500, tickSpacing: 5 },
    ]);
  });

  it('AMZN → ETH: v4 then v3 ending in WETH, delivered as native', () => {
    const plan = planFromTradingApi(amznToEth as TradingApiQuoteResponse, AMZN, NATIVE, 10n ** 18n, WETH);
    expect(plan.paths[0].hops.map(h => h.venue)).toEqual([RouteVenue.v4, RouteVenue.v3]);
    expect(plan.paths[0].hops[1].tokenOut).toBe(WETH);
  });

  it('cbBTC → ETH: three paths keep their input split', () => {
    const plan = planFromTradingApi(cbbtcToEth as TradingApiQuoteResponse, CBBTC, NATIVE, 100_000_000n, WETH);
    expect(plan.paths).toHaveLength(3);
    expect(pathSharesBps(plan.paths).sort()).toEqual([1000, 4000, 5000].sort());
    expect(plan.amountOut).toBe(34961642824809288237n);
  });

  it('ETH → TSLAon: two v4 pools from native ETH', () => {
    const plan = planFromTradingApi(ethToTslaon as TradingApiQuoteResponse, NATIVE, TSLAON, 5n * 10n ** 15n, WETH);
    expect(plan.paths[0].hops).toEqual([
      { venue: RouteVenue.v4, tokenIn: NATIVE, tokenOut: USDG, fee: 100, tickSpacing: 1 },
      { venue: RouteVenue.v4, tokenIn: USDG, tokenOut: TSLAON, fee: 3000, tickSpacing: 1 },
    ]);
  });

  it('recovers native ETH from a v4 hop the API labelled with the WETH address', () => {
    const resp = clone(ethToTslaon) as TradingApiQuoteResponse;
    resp.quote!.route![0][0].tokenIn.address = WETH; // pool id is still the native/USDG pool
    const plan = planFromTradingApi(resp, NATIVE, TSLAON, 5n * 10n ** 15n, WETH);
    expect(plan.paths[0].hops[0].tokenIn).toBe(NATIVE);
  });

  it('keeps the three largest paths and scales the expected output', () => {
    const resp = clone(cbbtcToEth) as TradingApiQuoteResponse;
    const small: TradingApiHop[] = clone(resp.quote!.route![0]);
    small[0].amountIn = '1000000';
    small[0].amountOut = '350000000000000000';
    resp.quote!.route!.push(small);
    const plan = planFromTradingApi(resp, CBBTC, NATIVE, 101_000_000n, WETH);
    expect(plan.paths).toHaveLength(3);
    expect(plan.paths.some(p => p.amountIn === 1_000_000n)).toBe(false);
    // Kept 100M of 101M quoted input: output scales by 101/100.
    const keptOut = plan.paths.reduce((s, p) => s + p.amountOut, 0n);
    expect(plan.amountOut).toBe((keptOut * 101_000_000n) / 100_000_000n);
  });

  describe('rejects routes the adapter cannot execute', () => {
    const expectNoRoute = (fn: () => unknown, match: RegExp) => {
      expect(fn).toThrow(NoSupportedRouteError);
      expect(fn).toThrow(match);
    };

    it('a v4 pool with hooks', () => {
      const resp = clone(ethToAmzn) as TradingApiQuoteResponse;
      resp.quote!.route![0][1].hooks = '0x00000000000000000000000000000000000000c0';
      expectNoRoute(() => planFromTradingApi(resp, NATIVE, AMZN, 1n, WETH), /hooks/);
    });

    it('a v4 hop whose pool id does not match its key', () => {
      const resp = clone(ethToAmzn) as TradingApiQuoteResponse;
      resp.quote!.route![0][1].fee = '3000';
      expectNoRoute(() => planFromTradingApi(resp, NATIVE, AMZN, 1n, WETH), /pool id/);
    });

    it('a v2 pool', () => {
      const resp = clone(ethToAmzn) as TradingApiQuoteResponse;
      resp.quote!.route![0][0].type = 'v2-pool';
      expectNoRoute(() => planFromTradingApi(resp, NATIVE, AMZN, 1n, WETH), /v2-pool/);
    });

    it('a v3 fee tier the adapter does not allow', () => {
      const resp = clone(ethToAmzn) as TradingApiQuoteResponse;
      resp.quote!.route![0][0].fee = '2500';
      expectNoRoute(() => planFromTradingApi(resp, NATIVE, AMZN, 1n, WETH), /fee tier 2500/);
    });

    it('a quote whose simulation failed', () => {
      const resp = clone(ethToAmzn) as TradingApiQuoteResponse;
      resp.quote!.txFailureReasons = ['SIMULATION_ERROR'];
      expectNoRoute(() => planFromTradingApi(resp, NATIVE, AMZN, 1n, WETH), /simulation failed/);
    });

    it('UniswapX routing', () => {
      expectNoRoute(() => planFromTradingApi({ routing: 'DUTCH_V2' }, NATIVE, AMZN, 1n, WETH), /DUTCH_V2/);
    });

    it('a route that ends at a different token', () => {
      expectNoRoute(
        () => planFromTradingApi(ethToAmzn as TradingApiQuoteResponse, NATIVE, CBBTC, 1n, WETH),
        /does not end at the output/
      );
    });
  });
});

describe('validateRoutePlan (mirrors UniversalRouterSwapAdapter._validatePath)', () => {
  const hop = (venue: RouteVenue, tokenIn: Address, tokenOut: Address, fee = 500, tickSpacing = 0) => ({
    venue,
    tokenIn,
    tokenOut,
    fee,
    tickSpacing: venue === RouteVenue.v4 && tickSpacing === 0 ? 10 : tickSpacing,
  });

  it('rejects a path that passes back through the input asset (WETH twin of native)', () => {
    const paths = [
      {
        hops: [hop(RouteVenue.v4, NATIVE, USDG), hop(RouteVenue.v3, USDG, WETH), hop(RouteVenue.v3, WETH, AMZN)],
      },
    ];
    expect(() => validateRoutePlan(paths, NATIVE, AMZN, WETH)).toThrow(/passes through the input or output/);
  });

  it('rejects native in, WETH out', () => {
    expect(() => validateRoutePlan([{ hops: [hop(RouteVenue.v3, WETH, USDG)] }], NATIVE, WETH, WETH)).toThrow(
      /same asset/
    );
  });

  it('lets native input enter a v4 WETH pool (the router wraps it), but not WETH input a native pool', () => {
    expect(() => validateRoutePlan([{ hops: [hop(RouteVenue.v4, WETH, AMZN)] }], NATIVE, AMZN, WETH)).not.toThrow();
    expect(() => validateRoutePlan([{ hops: [hop(RouteVenue.v4, NATIVE, AMZN)] }], WETH, AMZN, WETH)).toThrow(
      /does not start at the input/
    );
  });

  it('allows native ↔ WETH only where the venue changes', () => {
    expect(() =>
      validateRoutePlan(
        [{ hops: [hop(RouteVenue.v4, USDG, NATIVE, 100, 1), hop(RouteVenue.v3, WETH, SPY)] }],
        USDG,
        SPY,
        WETH
      )
    ).not.toThrow();
    expect(() =>
      validateRoutePlan(
        [{ hops: [hop(RouteVenue.v4, USDG, NATIVE, 100, 1), hop(RouteVenue.v4, WETH, SPY, 500, 10)] }],
        USDG,
        SPY,
        WETH
      )
    ).toThrow(/broken at hop 2/);
  });

  it('rejects dynamic-fee v4 pools and more than 3 paths / 4 hops', () => {
    expect(() =>
      validateRoutePlan([{ hops: [hop(RouteVenue.v4, NATIVE, AMZN, 0x800000, 60)] }], NATIVE, AMZN, WETH)
    ).toThrow(/dynamic/);
    const p = { hops: [hop(RouteVenue.v4, NATIVE, AMZN, 3000, 60)] };
    expect(() => validateRoutePlan([p, p, p, p], NATIVE, AMZN, WETH)).toThrow(/4 paths/);
    const long = {
      hops: [
        hop(RouteVenue.v3, WETH, USDG),
        hop(RouteVenue.v3, USDG, SPY),
        hop(RouteVenue.v3, SPY, CBBTC),
        hop(RouteVenue.v3, CBBTC, TSLAON),
        hop(RouteVenue.v3, TSLAON, AMZN),
      ],
    };
    expect(() => validateRoutePlan([long], NATIVE, AMZN, WETH)).toThrow(/5 hops/);
  });
});

describe('encodeMultiPathRoute', () => {
  it('matches the Solidity abi.encode(RouteKind.MULTI_PATH_EXACT_IN, abi.encode(Path[])) layout', () => {
    const plan = planFromTradingApi(ethToAmzn as TradingApiQuoteResponse, NATIVE, AMZN, 3577141523813693n, WETH);
    // `cast abi-encode` of the same route (see the plan in vault-contract-solidity test/fork/MultiPathRoutes).
    const expected =
      '0x0000000000000000000000000000000000000000000000000000000000000003' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000200' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000002710' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000002' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73' +
      '000000000000000000000000117cc2133c37b721f49de2a7a74833232b3b4c0c' +
      '00000000000000000000000000000000000000000000000000000000000001f4' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000000000000000001' +
      '000000000000000000000000117cc2133c37b721f49de2a7a74833232b3b4c0c' +
      '00000000000000000000000012f190a9f9d7d37a250758b26824b97ce941bf54' +
      '00000000000000000000000000000000000000000000000000000000000001f4' +
      '0000000000000000000000000000000000000000000000000000000000000005';
    expect(encodeMultiPathRoute(plan, WETH)).toBe(expected);
  });

  it('encodes three paths with shares summing to 10000', () => {
    const plan = planFromTradingApi(cbbtcToEth as TradingApiQuoteResponse, CBBTC, NATIVE, 100_000_000n, WETH);
    const { kind, paths } = decodeRoute(encodeMultiPathRoute(plan, WETH));
    expect(kind).toBe(3);
    expect(paths.map(p => p.shareBps).reduce((s, x) => s + x, 0)).toBe(10_000);
    const viaUsdg = paths.find(p => p.hops.length === 2);
    expect(viaUsdg?.hops.map(h => h.tokenOut.toLowerCase())).toEqual([USDG, WETH]);
    expect(viaUsdg?.shareBps).toBe(1000);
  });
});

describe('v4PoolId', () => {
  it('matches the pool ids the Trading API reports', () => {
    expect(v4PoolId(NATIVE, USDG, 100, 1)).toBe('0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e');
    expect(v4PoolId(AMZN, SPY, 500, 5)).toBe('0x68beff3b4270ffbbb78a48d7670648909b9de6736456b0f450fee242e1d10a8b');
  });
});
