import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/** The read side of the project's viem client (`EvmContractReader.publicClient` is untyped on purpose). */
export interface ReadClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/**
 * `GuardedUniversalRouterSwapAdapter` (vault-contract-solidity) screens every vault swap:
 * every pool in the route must be allowlisted by the Safe, and a vault may sell at most
 * `dailyCapBps` of an asset per 24 h. These helpers let the backend refuse a trade with a
 * clear reason before it signs, instead of sending a transaction that reverts.
 *
 * An adapter is "guarded" when it answers `dailyCapBps()`; older adapters (and the
 * LiquidityExitAdapter) do not, and every check below is a no-op for them.
 */
export const GUARDED_SWAP_ADAPTER_ABI = [
  {
    type: 'function',
    name: 'dailyCapBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'firstDisallowedPool',
    stateMutability: 'view',
    inputs: [{ name: 'route', type: 'bytes' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'remainingCap',
    stateMutability: 'view',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const ZERO_POOL = `0x${'0'.repeat(64)}`;

/** Adapter code never changes, so whether it is guarded is cached per address. */
const guardedCache = new Map<string, boolean>();

/** A route uses a pool the Safe has not allowlisted on the guarded swap adapter. */
export class PoolNotAllowlistedError extends Error {
  constructor(
    readonly adapter: Address,
    readonly poolId: Hex
  ) {
    super(
      `The route uses a Uniswap pool that is not on the swap adapter's allowlist (pool id ${poolId}). ` +
        `It must be approved by the L4VA Safe on ${adapter} before vaults can trade through it.`
    );
    this.name = 'PoolNotAllowlistedError';
  }
}

/** The trade would exceed the vault's daily sell cap for this asset. */
export class DailySwapCapError extends Error {
  constructor(
    readonly vault: Address,
    readonly asset: Address,
    readonly requested: bigint,
    readonly remaining: bigint
  ) {
    super(
      `Vault ${vault} may sell at most ${remaining} more base units of ${asset} right now ` +
        `(requested ${requested}). The cap protects vault assets; split the trade or wait — the allowance refills over 24 h.`
    );
    this.name = 'DailySwapCapError';
  }
}

export async function isGuardedSwapAdapter(client: ReadClient, adapter: Address): Promise<boolean> {
  const key = adapter.toLowerCase();
  const cached = guardedCache.get(key);
  if (cached !== undefined) return cached;
  let guarded: boolean;
  try {
    const bps = Number(
      await client.readContract({ address: adapter, abi: GUARDED_SWAP_ADAPTER_ABI, functionName: 'dailyCapBps' })
    );
    guarded = Number.isInteger(bps) && bps >= 1 && bps <= 10_000;
  } catch {
    guarded = false;
  }
  guardedCache.set(key, guarded);
  return guarded;
}

/** First non-allowlisted pool of `route`, or null when every pool is allowed (or the adapter is not guarded). */
export async function disallowedPool(client: ReadClient, adapter: Address, route: Hex): Promise<Hex | null> {
  if (!route || route === '0x') return null;
  if (!(await isGuardedSwapAdapter(client, adapter))) return null;
  const id = (await client.readContract({
    address: adapter,
    abi: GUARDED_SWAP_ADAPTER_ABI,
    functionName: 'firstDisallowedPool',
    args: [route],
  })) as Hex;
  if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
    throw new Error(`Unexpected firstDisallowedPool() result from ${adapter}: ${String(id)}`);
  }
  return id.toLowerCase() === ZERO_POOL ? null : id;
}

/**
 * Throws {@link PoolNotAllowlistedError} or {@link DailySwapCapError} when a guarded adapter
 * would revert this vault swap. A no-op for any other adapter.
 */
export async function assertSwapAllowed(
  client: ReadClient,
  params: { vault: Address; adapter: Address; assetIn: Address; amountIn: bigint; route: Hex }
): Promise<void> {
  if (!(await isGuardedSwapAdapter(client, params.adapter))) return;
  const pool = await disallowedPool(client, params.adapter, params.route);
  if (pool) throw new PoolNotAllowlistedError(params.adapter, pool);
  const remaining = (await client.readContract({
    address: params.adapter,
    abi: GUARDED_SWAP_ADAPTER_ABI,
    functionName: 'remainingCap',
    args: [params.vault, params.assetIn],
  })) as bigint;
  if (params.amountIn > remaining) {
    throw new DailySwapCapError(params.vault, params.assetIn, params.amountIn, remaining);
  }
}

/** One pool of a route, as the guarded adapter identifies it. */
export interface GuardedPool {
  id: Hex;
  venue: 'v3' | 'v4';
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
}

const sortPair = (a: Address, b: Address): [Address, Address] => {
  const x = a.toLowerCase() as Address;
  const y = b.toLowerCase() as Address;
  return x < y ? [x, y] : [y, x];
};

/**
 * Pool id exactly as `GuardedUniversalRouterSwapAdapter.v3PoolId / v4PoolId` computes it:
 *   v3: keccak256(abi.encode(uint8(0), token0, token1, uint24 fee))           (WETH, never native)
 *   v4: keccak256(abi.encode(uint8(1), currency0, currency1, uint24 fee, int24 tickSpacing))
 */
export function guardedPoolOf(hop: {
  venue: number;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  tickSpacing: number;
}): GuardedPool {
  const [token0, token1] = sortPair(hop.tokenIn, hop.tokenOut);
  if (hop.venue === 0) {
    const id = keccak256(
      encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }],
        [0, token0, token1, hop.fee]
      )
    );
    return { id, venue: 'v3', token0, token1, fee: hop.fee, tickSpacing: 0 };
  }
  const id = keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }],
      [1, token0, token1, hop.fee, hop.tickSpacing]
    )
  );
  return { id, venue: 'v4', token0, token1, fee: hop.fee, tickSpacing: hop.tickSpacing };
}

/** Every pool a multi-path route plan touches, de-duplicated. */
export function routePools(plan: {
  paths: { hops: { venue: number; tokenIn: Address; tokenOut: Address; fee: number; tickSpacing: number }[] }[];
}): GuardedPool[] {
  const out = new Map<string, GuardedPool>();
  for (const path of plan.paths) {
    for (const hop of path.hops) {
      const pool = guardedPoolOf(hop);
      out.set(pool.id, pool);
    }
  }
  return [...out.values()];
}
