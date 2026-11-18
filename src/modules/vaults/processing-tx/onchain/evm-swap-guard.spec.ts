import { describe, expect, it, jest } from '@jest/globals';
import type { Address, Hex } from 'viem';

import {
  assertSwapAllowed,
  DailySwapCapError,
  disallowedPool,
  guardedPoolOf,
  isGuardedSwapAdapter,
  PoolNotAllowlistedError,
  routePools,
  type ReadClient,
} from './evm-swap-guard';

const VAULT = '0x00000000000000000000000000000000000000aa' as Address;
const ETH = '0x0000000000000000000000000000000000000000' as Address;
const ROUTE = '0x1234' as Hex;
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const BAD_POOL = `0x${'ab'.repeat(32)}` as Hex;

let n = 0;
/** A fresh adapter address per test: guarded-ness is cached per address. */
const nextAdapter = (): Address => `0x${(++n).toString(16).padStart(40, '0')}` as Address;

function client(reads: Record<string, unknown | Error>): ReadClient {
  return {
    readContract: jest.fn(async ({ functionName }: { functionName: string }): Promise<unknown> => {
      const v = reads[functionName];
      if (v === undefined || v instanceof Error) throw v ?? new Error(`revert ${functionName}`);
      return v;
    }),
  };
}

describe('evm-swap-guard', () => {
  it('treats adapters without dailyCapBps() as unguarded and checks nothing', async () => {
    const c = client({});
    const adapter = nextAdapter();
    expect(await isGuardedSwapAdapter(c, adapter)).toBe(false);
    await expect(
      assertSwapAllowed(c, { vault: VAULT, adapter, assetIn: ETH, amountIn: 10n ** 30n, route: ROUTE })
    ).resolves.toBeUndefined();
  });

  it('does not take an unrelated return value for a guarded adapter', async () => {
    const c = client({ dailyCapBps: 'TKN' });
    expect(await isGuardedSwapAdapter(c, nextAdapter())).toBe(false);
  });

  it('refuses a route through a pool that is not allowlisted', async () => {
    const c = client({ dailyCapBps: 2500, firstDisallowedPool: BAD_POOL, remainingCap: 10n ** 30n });
    const adapter = nextAdapter();
    expect(await disallowedPool(c, adapter, ROUTE)).toBe(BAD_POOL);
    await expect(
      assertSwapAllowed(c, { vault: VAULT, adapter, assetIn: ETH, amountIn: 1n, route: ROUTE })
    ).rejects.toBeInstanceOf(PoolNotAllowlistedError);
  });

  it('refuses a trade above the remaining daily cap', async () => {
    const c = client({ dailyCapBps: 2500, firstDisallowedPool: ZERO, remainingCap: 5n });
    await expect(
      assertSwapAllowed(c, { vault: VAULT, adapter: nextAdapter(), assetIn: ETH, amountIn: 6n, route: ROUTE })
    ).rejects.toBeInstanceOf(DailySwapCapError);
  });

  it('allows a trade within the cap through allowlisted pools', async () => {
    const c = client({ dailyCapBps: 2500, firstDisallowedPool: ZERO, remainingCap: 5n });
    await expect(
      assertSwapAllowed(c, { vault: VAULT, adapter: nextAdapter(), assetIn: ETH, amountIn: 5n, route: ROUTE })
    ).resolves.toBeUndefined();
  });

  it('skips the pool check for an empty route (the LP exit pull-back)', async () => {
    const c = client({ dailyCapBps: 2500, remainingCap: 10n });
    expect(await disallowedPool(c, nextAdapter(), '0x')).toBeNull();
  });
});

describe('guardedPoolOf (must match the contract)', () => {
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;
  const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

  it('v3: same id as GuardedUniversalRouterSwapAdapter.v3PoolId, order-independent', () => {
    // cast keccak $(cast abi-encode 'f(uint8,address,address,uint24)' 0 WETH USDG 500)
    const expected = '0xbe4017509043634e68f9a20f5d40b3fcf4b3d42459842dc77d9709f1429f1c24';
    expect(guardedPoolOf({ venue: 0, tokenIn: WETH, tokenOut: USDG, fee: 500, tickSpacing: 0 }).id).toBe(expected);
    expect(guardedPoolOf({ venue: 0, tokenIn: USDG, tokenOut: WETH, fee: 500, tickSpacing: 0 }).id).toBe(expected);
  });

  it('v4: same id as GuardedUniversalRouterSwapAdapter.v4PoolId (native = address(0))', () => {
    // cast keccak $(cast abi-encode 'f(uint8,address,address,uint24,int24)' 1 0x0 USDG 3000 60)
    const expected = '0x7ca56586757c1f7154e959482b6178acd6b33b675cc40f26e82e349bef12da10';
    expect(guardedPoolOf({ venue: 1, tokenIn: USDG, tokenOut: ETH, fee: 3000, tickSpacing: 60 }).id).toBe(expected);
  });

  it('routePools de-duplicates pools shared by several paths', () => {
    const hop = { venue: 1, tokenIn: ETH, tokenOut: USDG, fee: 3000, tickSpacing: 60 };
    expect(routePools({ paths: [{ hops: [hop] }, { hops: [hop] }] })).toHaveLength(1);
  });
});
