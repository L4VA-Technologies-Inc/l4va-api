import { encodeAbiParameters, encodePacked, isAddress, type Address, type Hex } from 'viem';

/**
 * Route encoding for `UniversalRouterSwapAdapter` (vault-contract-solidity).
 *
 * The adapter takes `route = abi.encode(RouteKind, data)`:
 *   - RouteKind.V3_EXACT_IN (0):        data = packed v3 path (token, fee, token[, fee, token…]), ≤ 3 hops.
 *                                       Native ETH legs are WETH in the path.
 *   - RouteKind.V4_EXACT_IN_SINGLE (1): data = abi.encode(PoolKey, zeroForOne). Native is address(0). No hooks.
 *   - RouteKind.V3_THEN_V4_SINGLE (2):  data = abi.encode(v3Path, PoolKey, zeroForOne). ERC-20 in → v3 path
 *                                       ending in WETH → unwrap → one v4 pool from native ETH to the output
 *                                       (e.g. USDG fees → WETH → ETH → L4VA).
 *
 * Keep this in lockstep with the contract; the adapter re-validates everything on-chain.
 */

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const ROUTE_KIND = { v3: 0, v4: 1, v3v4: 2 } as const;
export const ALLOWED_V3_FEES = new Set([100, 500, 3000, 10_000]);
export const MAX_V3_HOPS = 3;

export interface V3RouteConfig {
  kind: 'v3';
  /** Alternating token, fee, token[, fee, token…]. */
  path: Array<Address | number>;
}

export interface V4RouteConfig {
  kind: 'v4';
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks?: Address;
  zeroForOne: boolean;
}

export interface V3ThenV4RouteConfig {
  kind: 'v3v4';
  /** v3 leg: assetIn, fee, …, WETH. */
  path: Array<Address | number>;
  /** v4 leg: native ETH (address(0)) → assetOut. */
  pool: Omit<V4RouteConfig, 'kind'>;
}

export type RouteConfig = V3RouteConfig | V4RouteConfig | V3ThenV4RouteConfig;

const lower = (a: string) => a.toLowerCase();

export function encodeV3Path(path: Array<Address | number>): Hex {
  if (path.length < 3 || path.length % 2 === 0) {
    throw new Error('v3 path must be token,fee,token[,fee,token…]');
  }
  const hops = (path.length - 1) / 2;
  if (hops > MAX_V3_HOPS) throw new Error(`v3 path has ${hops} hops; max ${MAX_V3_HOPS}`);

  const types: Array<'address' | 'uint24'> = [];
  const values: Array<Address | number> = [];
  path.forEach((item, i) => {
    if (i % 2 === 0) {
      if (typeof item !== 'string' || !isAddress(item)) throw new Error(`v3 path[${i}] is not an address`);
      types.push('address');
    } else {
      if (typeof item !== 'number' || !ALLOWED_V3_FEES.has(item))
        throw new Error(`v3 path[${i}] fee ${item} not allowed`);
      types.push('uint24');
    }
    values.push(item);
  });
  return encodePacked(types, values);
}

const POOL_KEY_PARAM = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;

function v4PoolKey(pool: Omit<V4RouteConfig, 'kind'>) {
  const hooks = pool.hooks ?? ZERO_ADDRESS;
  if (lower(hooks) !== ZERO_ADDRESS) throw new Error('hooked v4 pools are not supported by the adapter');
  if (!isAddress(pool.currency0) || !isAddress(pool.currency1)) throw new Error('v4 currencies must be addresses');
  if (BigInt(pool.currency0) >= BigInt(pool.currency1)) throw new Error('v4 currency0 must sort before currency1');
  return {
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: ZERO_ADDRESS,
  };
}

export function encodeRoute(route: RouteConfig): Hex {
  if (route.kind === 'v3') {
    return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND.v3, encodeV3Path(route.path)]);
  }

  if (route.kind === 'v3v4') {
    const inner = encodeAbiParameters(
      [{ type: 'bytes' }, POOL_KEY_PARAM, { type: 'bool' }],
      [encodeV3Path(route.path), v4PoolKey(route.pool), route.pool.zeroForOne]
    );
    return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND.v3v4, inner]);
  }

  const inner = encodeAbiParameters([POOL_KEY_PARAM, { type: 'bool' }], [v4PoolKey(route), route.zeroForOne]);
  return encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND.v4, inner]);
}

/**
 * Off-chain mirror of the adapter's asset checks, so a misconfigured route is
 * rejected at startup instead of reverting in a keeper transaction.
 */
export function assertRouteMatches(route: RouteConfig, assetIn: Address, assetOut: Address, weth: Address): void {
  if (route.kind === 'v3') {
    const first = route.path[0] as Address;
    const last = route.path[route.path.length - 1] as Address;
    const expectedIn = lower(assetIn) === ZERO_ADDRESS ? weth : assetIn;
    const expectedOut = lower(assetOut) === ZERO_ADDRESS ? weth : assetOut;
    if (lower(first) !== lower(expectedIn) || lower(last) !== lower(expectedOut)) {
      throw new Error(`v3 route ${first}→${last} does not match ${assetIn}→${assetOut}`);
    }
    return;
  }
  if (route.kind === 'v3v4') {
    const first = route.path[0] as Address;
    const last = route.path[route.path.length - 1] as Address;
    const [cIn, cOut] = route.pool.zeroForOne
      ? [route.pool.currency0, route.pool.currency1]
      : [route.pool.currency1, route.pool.currency0];
    if (lower(first) !== lower(assetIn) || lower(last) !== lower(weth)) {
      throw new Error(`v3 leg ${first}→${last} must run ${assetIn}→WETH`);
    }
    if (lower(cIn) !== ZERO_ADDRESS || lower(cOut) !== lower(assetOut)) {
      throw new Error(`v4 leg ${cIn}→${cOut} must run native ETH→${assetOut}`);
    }
    return;
  }
  const [cIn, cOut] = route.zeroForOne ? [route.currency0, route.currency1] : [route.currency1, route.currency0];
  if (lower(cIn) !== lower(assetIn) || lower(cOut) !== lower(assetOut)) {
    throw new Error(`v4 route ${cIn}→${cOut} does not match ${assetIn}→${assetOut}`);
  }
}
