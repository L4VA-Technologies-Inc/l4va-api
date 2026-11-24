/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, jest } from '@jest/globals';
import type { Address, Hex } from 'viem';

import { EvmLpExitService } from './evm-lp-exit.service';

const VAULT = '0x00000000000000000000000000000000000000aa' as Address;
const VT = '0x00000000000000000000000000000000000000bb' as Address;
const LP_V2 = '0x00000000000000000000000000000000000000c2' as Address;
const EXIT_V2 = '0x00000000000000000000000000000000000000e2' as Address;
const POSM = '0x00000000000000000000000000000000000000dd' as Address;
const DUST = '0x00000000000000000000000000000000000000ee' as Address;
/** Contains PUSH4 burnHeldVaultToken() (0xdb946d64): a V12+ vault. */
const V12_CODE = '0x6001600263db946d6414' as Hex;
const OLD_CODE = '0x60016002' as Hex;

/**
 * `UniswapV4LiquidityAdapterV2` positions: the service withdraws with `withdrawToExit` (no
 * recipient, no `assign`), pulls native back through `Vault.swap` on the V2 exit adapter, and
 * releases the pool VT to the vault (2-argument `releaseToken`) before burning it.
 */
function setup(opts: { code: Hex; nativeOwed?: bigint; vtOwed?: bigint; configuredExit?: Address }) {
  const state = { liquidity: 5n, nativeOwed: 0n, vtOwed: 0n, vaultVt: 0n };
  const proceeds = { native: opts.nativeOwed ?? 2n * 10n ** 18n, vt: opts.vtOwed ?? 1_000n };

  const readContract = jest.fn(async ({ address, functionName, args }: any) => {
    switch (functionName) {
      case 'totalLiquidityPositions':
        return 1n;
      case 'getLiquidityPosition':
        return { positionAsset: LP_V2 };
      case 'liquidityOf':
        return state.liquidity;
      case 'exitAdapter':
        if (address === LP_V2) return EXIT_V2;
        throw new Error('not v2');
      case 'positionsOf':
        return [7n];
      case 'positionManager':
        return POSM;
      case 'getPositionLiquidity':
        return state.liquidity;
      case 'vaultToken':
        return VT;
      case 'nativeOwed':
        return state.nativeOwed;
      case 'tokenOwed':
        return state.vtOwed;
      case 'balanceOf':
        return (args[0] as string).toLowerCase() === VAULT ? state.vaultVt : 0n;
      case 'custodyTokens':
        return [DUST];
      case 'availableErc20ForOperations':
        return 10n;
      // The V1 flow that follows runs against no V1 adapter and an empty exit.
      case 'unassignedNative':
      case 'unassignedToken':
        if (address === EXIT_V2) throw new Error('unassignedNative reverted on V2 exit');
        return 0n;
      case 'unownedNative':
        if (address === EXIT_V2) return 0n;
        throw new Error('not v2 exit');
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });

  const sent: Array<{ to: string; fn: string; args: unknown[] }> = [];
  const sendAndConfirm = jest.fn(async (call: any) => {
    sent.push({ to: call.address, fn: call.functionName, args: call.args });
    if (call.functionName === 'withdrawToExit') {
      state.liquidity = 0n;
      state.nativeOwed += proceeds.native;
      state.vtOwed += proceeds.vt;
    }
    if (call.functionName === 'releaseToken') {
      state.vaultVt += state.vtOwed;
      state.vtOwed = 0n;
    }
    if (call.functionName === 'burnHeldVaultToken') state.vaultVt = 0n;
    return { hash: '0xhash', receipt: { blockNumber: 1n }, decodedEvents: [] };
  });
  const swap = jest.fn(async (_vaultId: string, p: any) => {
    sent.push({ to: VAULT, fn: 'vault.swap', args: [p.adapter, p.assetIn, p.minAmountOut] });
    state.nativeOwed = 0n;
    return { txHash: '0xswap' };
  });

  const service = new EvmLpExitService(
    { publicClient: { readContract, getCode: jest.fn(async () => opts.code) } } as any,
    { sendAndConfirm } as any,
    { swap, tradeFeeBps: async () => 25 } as any,
    { get: (k: string) => (k === 'EVM_LP_EXIT_ADAPTER_ADDRESS' ? opts.configuredExit : undefined) } as any,
    {} as any
  );
  const run = () =>
    (service as any).exitIntoVaultLocked({ id: 'vault-1', contract_address: VAULT, chain_id: 4663 }) as Promise<any>;
  return { state, sent, run, proceeds };
}

describe('EvmLpExitService with UniswapV4LiquidityAdapterV2', () => {
  it('withdraws to the exit adapter, pulls native back and burns the pool VT — no assign, no recipient', async () => {
    const t = setup({ code: V12_CODE });
    const r = await t.run();

    expect(t.sent.map(s => s.fn)).toEqual(['withdrawToExit', 'vault.swap', 'releaseToken', 'burnHeldVaultToken']);
    expect(t.sent[0]).toEqual({ to: LP_V2, fn: 'withdrawToExit', args: [7n] });
    expect(t.sent[1].args).toEqual([EXIT_V2, DUST, t.proceeds.native - (t.proceeds.native * 25n) / 10_000n]);
    expect(t.sent[2]).toEqual({ to: EXIT_V2, fn: 'releaseToken', args: [VAULT, VT] });
    expect(t.sent.some(s => s.fn === 'assign' || s.fn === 'withdrawLiquidity')).toBe(false);
    expect(r.withdrawnTokenIds).toEqual([7n]);
    expect(r.nativeReturned).toBe(t.proceeds.native);
    expect(r.vtBurned).toBe(t.proceeds.vt);
    expect(t.state).toMatchObject({ liquidity: 0n, nativeOwed: 0n, vtOwed: 0n, vaultVt: 0n });
  });

  it('resumes after a crash: nothing left in the pool, only the pull-back and burn run', async () => {
    const t = setup({ code: V12_CODE });
    t.state.liquidity = 0n;
    t.state.nativeOwed = 1n;
    t.state.vtOwed = 3n;
    await t.run();
    expect(t.sent.map(s => s.fn)).toEqual(['vault.swap', 'releaseToken', 'burnHeldVaultToken']);
  });

  it('refuses to release pool VT to a vault that cannot burn it', async () => {
    const t = setup({ code: OLD_CODE });
    await expect(t.run()).rejects.toThrow(/cannot burn VT/);
    expect(t.sent.some(s => s.fn === 'releaseToken')).toBe(false);
  });

  it('V13+: configured lpExitAdapter is the V2 exit — V1 flow is skipped, no unassignedNative call', async () => {
    const t = setup({ code: V12_CODE, configuredExit: EXIT_V2 });
    const r = await t.run();
    expect(t.sent.map(s => s.fn)).toEqual(['withdrawToExit', 'vault.swap', 'releaseToken', 'burnHeldVaultToken']);
    expect(r.vtBurned).toBe(t.proceeds.vt);
  });

  it('V13+: retry after a completed V2 exit is a no-op', async () => {
    const t = setup({ code: V12_CODE, configuredExit: EXIT_V2 });
    t.state.liquidity = 0n;
    await t.run();
    expect(t.sent).toEqual([]);
  });
});
