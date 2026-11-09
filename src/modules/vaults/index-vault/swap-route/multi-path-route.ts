import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/**
 * `UniversalRouterSwapAdapter.MULTI_PATH_EXACT_IN` — the only route format the
 * API builds for Uniswap trades.
 *
 * Everything here is pure. {@link validateRoutePlan} mirrors the adapter's
 * `_validatePath` / `_buildMultiPath` checks one for one, so a route that
 * passes here is a route the adapter accepts. Keep the two in sync: a check
 * that exists only on-chain turns into a failed trade after we have already
 * told the user the token is tradable.
 */

export const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

/** `UniversalRouterSwapAdapter.RouteKind.MULTI_PATH_EXACT_IN`. */
export const ROUTE_KIND_MULTI_PATH_EXACT_IN = 3;

/** Adapter limits (`MAX_PATHS`, `MAX_PATH_HOPS`, `V4_MAX_FEE`, `V4_MAX_TICK_SPACING`). */
export const MULTI_PATH_LIMITS = {
  maxPaths: 3,
  maxHopsPerPath: 4,
  v3Fees: [100, 500, 3000, 10_000] as readonly number[],
  v4MaxFee: 1_000_000,
  v4MaxTickSpacing: 32_767,
} as const;

const BPS = 10_000n;

export enum RouteVenue {
  v3 = 0,
  v4 = 1,
}

/** One pool. v4 uses `NATIVE` for ETH; v3 never does (WETH). `tickSpacing` is 0 for v3. */
export interface RouteHop {
  venue: RouteVenue;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
}

export interface RoutePath {
  /** Input this path was quoted with. Only the ratio between paths reaches the chain. */
  amountIn: bigint;
  /** Output the quote expects from this path, before the vault's trade fee. */
  amountOut: bigint;
  hops: RouteHop[];
}

export interface RoutePlan {
  assetIn: Address;
  assetOut: Address;
  amountIn: bigint;
  /** Expected output before the vault's trade fee. */
  amountOut: bigint;
  paths: RoutePath[];
  source: 'trading_api' | 'onchain';
}

/**
 * No route the vault's swap adapter can execute. Thrown on purpose (never for
 * an outage), so callers can tell "this token cannot be traded" from "try again".
 */
export class NoSupportedRouteError extends Error {
  constructor(
    readonly assetIn: Address,
    readonly assetOut: Address,
    readonly reason: string
  ) {
    super(`No supported Uniswap route ${assetIn} → ${assetOut}: ${reason}`);
    this.name = 'NoSupportedRouteError';
  }
}

const lower = (a: string): Address => a.toLowerCase() as Address;

/** Equal, or native ETH and WETH (the adapter's `_sameAsset`). */
export function sameAsset(a: Address, b: Address, weth: Address): boolean {
  const x = lower(a);
  const y = lower(b);
  const w = lower(weth);
  return x === y || (x === NATIVE && y === w) || (x === w && y === NATIVE);
}

/** Uniswap v4 pool id: keccak256(abi.encode(PoolKey)), hookless. */
export function v4PoolId(tokenA: Address, tokenB: Address, fee: number, tickSpacing: number): Hex {
  const [currency0, currency1] = lower(tokenA) < lower(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [currency0, currency1, fee, tickSpacing, NATIVE]
    )
  );
}

/**
 * Throws {@link NoSupportedRouteError} unless the adapter would accept `paths`
 * for a swap `assetIn → assetOut`. Same rules, same order as the contract.
 */
export function validateRoutePlan(
  paths: Pick<RoutePath, 'hops'>[],
  assetIn: Address,
  assetOut: Address,
  weth: Address
): void {
  const fail = (reason: string): never => {
    throw new NoSupportedRouteError(assetIn, assetOut, reason);
  };
  if (sameAsset(assetIn, assetOut, weth)) fail('input and output are the same asset');
  if (paths.length === 0 || paths.length > MULTI_PATH_LIMITS.maxPaths) {
    fail(`route splits into ${paths.length} paths (max ${MULTI_PATH_LIMITS.maxPaths})`);
  }

  paths.forEach(({ hops }, p) => {
    if (hops.length === 0 || hops.length > MULTI_PATH_LIMITS.maxHopsPerPath) {
      fail(`path ${p + 1} has ${hops.length} hops (max ${MULTI_PATH_LIMITS.maxHopsPerPath})`);
    }
    hops.forEach((h, k) => {
      if (lower(h.tokenIn) === lower(h.tokenOut)) fail(`path ${p + 1} hop ${k + 1} swaps a token for itself`);
      if (h.venue === RouteVenue.v3) {
        if (lower(h.tokenIn) === NATIVE || lower(h.tokenOut) === NATIVE) fail('a v3 pool cannot hold native ETH');
        if (!MULTI_PATH_LIMITS.v3Fees.includes(h.fee)) fail(`v3 fee tier ${h.fee} is not allowed`);
        if (h.tickSpacing !== 0) fail('v3 hop carries a tick spacing');
      } else if (h.venue === RouteVenue.v4) {
        if (!Number.isInteger(h.fee) || h.fee < 0 || h.fee > MULTI_PATH_LIMITS.v4MaxFee) {
          fail(`v4 pool fee ${h.fee} is dynamic or out of range`);
        }
        if (
          !Number.isInteger(h.tickSpacing) ||
          h.tickSpacing < 1 ||
          h.tickSpacing > MULTI_PATH_LIMITS.v4MaxTickSpacing
        ) {
          fail(`v4 tick spacing ${h.tickSpacing} is out of range`);
        }
      } else {
        fail(`unknown venue ${String(h.venue)}`);
      }

      if (k > 0) {
        const prev = hops[k - 1];
        const linked =
          prev.venue === h.venue
            ? lower(prev.tokenOut) === lower(h.tokenIn)
            : sameAsset(prev.tokenOut, h.tokenIn, weth);
        if (!linked) fail(`path ${p + 1} is broken at hop ${k + 1}`);
      }
      if (k + 1 < hops.length) {
        if (sameAsset(h.tokenOut, assetIn, weth) || sameAsset(h.tokenOut, assetOut, weth)) {
          fail(`path ${p + 1} passes through the input or output asset`);
        }
      }
    });

    const first = hops[0];
    // Native input may enter a WETH pool (the router wraps it); WETH input never enters a native pool.
    const startOk =
      lower(first.tokenIn) === lower(assetIn) || (lower(assetIn) === NATIVE && lower(first.tokenIn) === lower(weth));
    if (!startOk) fail(`path ${p + 1} does not start at the input asset`);
    if (!sameAsset(hops[hops.length - 1].tokenOut, assetOut, weth)) {
      fail(`path ${p + 1} does not end at the output asset`);
    }
  });
}

/** Path shares in bps, as the adapter applies them (last path takes the remainder). */
export function pathSharesBps(paths: Pick<RoutePath, 'amountIn'>[]): number[] {
  const total = paths.reduce((s, p) => s + p.amountIn, 0n);
  if (total === 0n) return paths.map((_, i) => (i === paths.length - 1 ? 10_000 : 0));
  const shares = paths.map(p => Number((p.amountIn * BPS) / total));
  shares[shares.length - 1] = 10_000 - shares.slice(0, -1).reduce((s, x) => s + x, 0);
  return shares;
}

const HOP_COMPONENTS = [
  { name: 'venue', type: 'uint8' },
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
] as const;

const PATHS_PARAM = [
  {
    type: 'tuple[]',
    components: [
      { name: 'shareBps', type: 'uint16' },
      { name: 'hops', type: 'tuple[]', components: HOP_COMPONENTS },
    ],
  },
] as const;

/** `abi.encode(RouteKind.MULTI_PATH_EXACT_IN, abi.encode(Path[]))`. Validates first. */
export function encodeMultiPathRoute(plan: RoutePlan, weth: Address): Hex {
  validateRoutePlan(plan.paths, plan.assetIn, plan.assetOut, weth);
  const shares = pathSharesBps(plan.paths);
  if (shares.some(s => s <= 0)) {
    throw new NoSupportedRouteError(plan.assetIn, plan.assetOut, 'a path receives no share of the input');
  }
  const data = encodeAbiParameters(PATHS_PARAM, [
    plan.paths.map((p, i) => ({
      shareBps: shares[i],
      hops: p.hops.map(h => ({
        venue: h.venue,
        tokenIn: h.tokenIn,
        tokenOut: h.tokenOut,
        fee: h.fee,
        tickSpacing: h.tickSpacing,
      })),
    })),
  ]);
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND_MULTI_PATH_EXACT_IN, data]);
}

// ---------------------------------------------------------------------------
// Uniswap Trading API → RoutePlan
// ---------------------------------------------------------------------------

/** The subset of a Trading API `/quote` response this module reads. */
export interface TradingApiQuoteResponse {
  routing?: string;
  quote?: {
    output?: { amount?: string };
    txFailureReasons?: string[] | null;
    route?: TradingApiHop[][];
  };
}

export interface TradingApiHop {
  type: string;
  address: string;
  tokenIn: { address: string };
  tokenOut: { address: string };
  fee?: string | number;
  tickSpacing?: string | number;
  hooks?: string;
  amountIn?: string;
  amountOut?: string;
}

/**
 * Turn a CLASSIC Trading API quote into a plan the adapter executes exactly.
 *
 * Paths the adapter cannot carry are dropped (over-long paths, and beyond the
 * {@link MULTI_PATH_LIMITS.maxPaths} largest), and the expected output is then
 * scaled from the kept paths. Execution re-prices the encoded route by
 * simulation, so this estimate only has to be close, never exact.
 */
export function planFromTradingApi(
  resp: TradingApiQuoteResponse,
  assetIn: Address,
  assetOut: Address,
  amountIn: bigint,
  weth: Address
): RoutePlan {
  const fail = (reason: string): never => {
    throw new NoSupportedRouteError(assetIn, assetOut, reason);
  };
  if (resp.routing !== 'CLASSIC') fail(`Trading API returned ${resp.routing ?? 'no'} routing`);
  const failures = resp.quote?.txFailureReasons ?? [];
  if (failures.length) fail(`Trading API simulation failed: ${failures.join(', ')}`);
  const raw = resp.quote?.route ?? [];
  if (!raw.length) fail('Trading API returned no route');

  const parsed: RoutePath[] = raw.map((hops, p) => {
    if (!hops.length) fail(`path ${p + 1} is empty`);
    const out = hops.map((h, k) => parseHop(h, p, k, weth, fail));
    return {
      amountIn: BigInt(hops[0].amountIn ?? 0),
      amountOut: BigInt(hops[hops.length - 1].amountOut ?? 0),
      hops: out,
    };
  });

  const usable = parsed
    .filter(p => p.hops.length <= MULTI_PATH_LIMITS.maxHopsPerPath)
    .sort((a, b) => (b.amountIn > a.amountIn ? 1 : b.amountIn < a.amountIn ? -1 : 0))
    .slice(0, MULTI_PATH_LIMITS.maxPaths);
  if (!usable.length) fail(`every path is longer than ${MULTI_PATH_LIMITS.maxHopsPerPath} hops`);

  const quotedIn = parsed.reduce((s, p) => s + p.amountIn, 0n);
  const keptIn = usable.reduce((s, p) => s + p.amountIn, 0n);
  const keptOut = usable.reduce((s, p) => s + p.amountOut, 0n);
  if (keptIn === 0n || keptOut === 0n) fail('route quotes zero output');
  const quotedTotal = BigInt(resp.quote?.output?.amount ?? 0);
  const amountOut = usable.length === parsed.length && quotedTotal > 0n ? quotedTotal : (keptOut * quotedIn) / keptIn;

  validateRoutePlan(usable, assetIn, assetOut, weth);
  return { assetIn, assetOut, amountIn, amountOut, paths: usable, source: 'trading_api' };
}

function parseHop(h: TradingApiHop, p: number, k: number, weth: Address, fail: (reason: string) => never): RouteHop {
  const tokenIn = lower(h.tokenIn?.address ?? '');
  const tokenOut = lower(h.tokenOut?.address ?? '');
  const fee = Number(h.fee);
  if (h.type === 'v3-pool') {
    return { venue: RouteVenue.v3, tokenIn, tokenOut, fee, tickSpacing: 0 };
  }
  if (h.type === 'v4-pool') {
    const hooks = lower(h.hooks ?? NATIVE);
    if (hooks !== NATIVE) fail(`path ${p + 1} hop ${k + 1} uses a v4 pool with hooks`);
    const tickSpacing = Number(h.tickSpacing);
    if (!Number.isInteger(fee) || !Number.isInteger(tickSpacing)) {
      fail(`path ${p + 1} hop ${k + 1} has no static fee / tick spacing`);
    }
    // The Trading API can label native ETH with the WETH address in v4 hops.
    // The pool id says which currencies the pool really has.
    const id = lower(h.address);
    const w = lower(weth);
    const candidates: Array<[Address, Address]> = [[tokenIn, tokenOut]];
    if (tokenIn === w) candidates.push([NATIVE, tokenOut]);
    if (tokenOut === w) candidates.push([tokenIn, NATIVE]);
    const match = candidates.find(([a, b]) => lower(v4PoolId(a, b, fee, tickSpacing)) === id);
    if (!match) fail(`path ${p + 1} hop ${k + 1} does not match its v4 pool id`);
    const [inC, outC] = match as [Address, Address];
    return { venue: RouteVenue.v4, tokenIn: inC, tokenOut: outC, fee, tickSpacing };
  }
  return fail(`path ${p + 1} hop ${k + 1} uses a ${h.type} pool`);
}

/** "v3 0.05% WETH→SPY › v4 0.05% SPY→AMZN | …" for logs and the UI. */
export function describeRoute(plan: Pick<RoutePlan, 'paths'>, symbolOf: (a: Address) => string): string {
  const shares = pathSharesBps(plan.paths);
  return plan.paths
    .map((p, i) => {
      const hops = p.hops
        .map(
          h => `v${h.venue === RouteVenue.v3 ? 3 : 4} ${symbolOf(h.tokenIn)}→${symbolOf(h.tokenOut)} ${h.fee / 10_000}%`
        )
        .join(' › ');
      return plan.paths.length > 1 ? `${(shares[i] / 100).toFixed(0)}%: ${hops}` : hops;
    })
    .join(' | ');
}
