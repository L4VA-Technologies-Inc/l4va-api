import { describe, expect, it, jest } from '@jest/globals';
import { toFunctionSelector, type Address, type Hex } from 'viem';

import { EvmLpExitService, vaultCodeBurnsHeldVt } from './evm-lp-exit.service';

const VAULT = '0x00000000000000000000000000000000000000aa' as Address;
const VT = '0x00000000000000000000000000000000000000bb' as Address;
const EXIT_ADAPTER = '0x00000000000000000000000000000000000000cc' as Address;
const ALICE = '0x00000000000000000000000000000000000000a1';
const CAROL = '0x00000000000000000000000000000000000000c1';

const BURN_DISPATCH = `63${toFunctionSelector('burnHeldVaultToken()').slice(2)}`;
const V12_CODE = `0x6080604052${BURN_DISPATCH}14610010575b00` as Hex;
const OLD_CODE = '0x60806040526004361061001057600080fd5b00' as Hex;

/**
 * Chain stand-in for step 4 of the LP exit: no live positions and no native owed, so the run goes
 * straight to the pool's VT. `tokenOwed` and the vault's VT balance move as the admin txs land.
 */
function setup(opts: { code: Hex; tokenOwed: bigint; vaultVt?: bigint }) {
  const state = { tokenOwed: opts.tokenOwed, vaultVt: opts.vaultVt ?? 0n };

  const readContract = jest.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    switch (functionName) {
      case 'totalLiquidityPositions':
        return 0n;
      case 'vaultToken':
        return VT;
      case 'unassignedNative':
      case 'unassignedToken':
      case 'nativeOwed':
        return 0n;
      case 'tokenOwed':
        return state.tokenOwed;
      case 'balanceOf':
        return (args![0] as string).toLowerCase() === VAULT ? state.vaultVt : 0n;
      case 'isExcludedHolder':
        return false;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  });
  const getCode = jest.fn(async () => opts.code);

  const sent: Array<{ to: string; fn: string; args: unknown[] }> = [];
  const sendAndConfirm = jest.fn(
    async (call: { address: Address; functionName: string; args: unknown[] }, _events: string[]) => {
      sent.push({ to: call.address, fn: call.functionName, args: call.args });
      if (call.functionName === 'releaseToken') {
        const [, , to, amounts] = call.args as [Address, Address, string[], bigint[]];
        const total = amounts.reduce((a, b) => a + b, 0n);
        if (total > state.tokenOwed) throw new Error('ExceedsOwed');
        state.tokenOwed -= total;
        to.forEach((addr, i) => {
          if (addr.toLowerCase() === VAULT) state.vaultVt += amounts[i];
        });
      }
      if (call.functionName === 'burnHeldVaultToken') {
        if (state.vaultVt === 0n) throw new Error('AmountZero');
        state.vaultVt = 0n;
      }
      return { hash: '0xhash', receipt: { blockNumber: 1n }, decodedEvents: [] };
    }
  );

  const service = new EvmLpExitService(
    { publicClient: { readContract, getCode } } as any,
    { sendAndConfirm } as any,
    {} as any,
    { get: (key: string) => (key === 'EVM_LP_EXIT_ADAPTER_ADDRESS' ? EXIT_ADAPTER : undefined) } as any,
    {} as any
  );
  const holderBalances = jest.spyOn(service as any, 'holderBalances').mockResolvedValue(
    new Map([
      [ALICE, 600n],
      [CAROL, 300n],
    ]) as never
  );

  const run = () =>
    (service as any).exitIntoVaultLocked({ id: 'vault-1', contract_address: VAULT, chain_id: 4663 }) as Promise<{
      vtBurned: bigint;
      vtReleased: bigint;
    }>;

  return { service, state, sent, getCode, holderBalances, run };
}

describe('vaultCodeBurnsHeldVt', () => {
  it('detects the burnHeldVaultToken dispatch in V12+ vault code', () => {
    expect(vaultCodeBurnsHeldVt(V12_CODE)).toBe(true);
    expect(vaultCodeBurnsHeldVt(V12_CODE.toUpperCase().replace('0X', '0x') as Hex)).toBe(true);
  });

  it('is false for older vault code and for no code', () => {
    expect(vaultCodeBurnsHeldVt(OLD_CODE)).toBe(false);
    expect(vaultCodeBurnsHeldVt('0x')).toBe(false);
    expect(vaultCodeBurnsHeldVt(undefined)).toBe(false);
  });
});

describe('EvmLpExitService step 4: the pool VT', () => {
  it('V12+: moves the pool VT onto the vault and burns it, without a holder list', async () => {
    const t = setup({ code: V12_CODE, tokenOwed: 1_000n });

    const r = await t.run();

    expect(t.sent.map(s => s.fn)).toEqual(['releaseToken', 'burnHeldVaultToken']);
    expect(t.sent[0]).toEqual({
      to: EXIT_ADAPTER,
      fn: 'releaseToken',
      args: [VAULT, VT, [VAULT], [1_000n]],
    });
    expect(t.sent[1].to).toBe(VAULT);
    expect(r.vtBurned).toBe(1_000n);
    expect(r.vtReleased).toBe(0n);
    expect(t.state).toEqual({ tokenOwed: 0n, vaultVt: 0n });
    expect(t.holderBalances).not.toHaveBeenCalled();
  });

  it('V12+: a run that stopped after the release only burns what the vault holds', async () => {
    const t = setup({ code: V12_CODE, tokenOwed: 0n, vaultVt: 1_000n });

    const r = await t.run();

    expect(t.sent.map(s => s.fn)).toEqual(['burnHeldVaultToken']);
    expect(r.vtBurned).toBe(1_000n);
  });

  it('V12+: nothing owed and nothing held sends nothing', async () => {
    const t = setup({ code: V12_CODE, tokenOwed: 0n });

    const r = await t.run();

    expect(t.sent).toEqual([]);
    expect(r.vtBurned).toBe(0n);
  });

  it('older vaults keep releasing the pool VT to holders pro rata', async () => {
    const t = setup({ code: OLD_CODE, tokenOwed: 900n });

    const r = await t.run();

    expect(t.sent.map(s => s.fn)).toEqual(['releaseToken']);
    const [, , to, amounts] = t.sent[0].args as [Address, Address, string[], bigint[]];
    expect(to).toEqual([ALICE, CAROL]);
    expect(amounts).toEqual([600n, 300n]);
    expect(r.vtReleased).toBe(900n);
    expect(r.vtBurned).toBe(0n);
  });

  it('reads the vault code once per vault', async () => {
    const t = setup({ code: V12_CODE, tokenOwed: 0n });
    await t.run();
    await t.run();
    expect(t.getCode).toHaveBeenCalledTimes(1);
  });

  it('refuses to guess when the vault address has no code', async () => {
    const t = setup({ code: '0x', tokenOwed: 1_000n });
    await expect(t.run()).rejects.toThrow('No contract code');
    expect(t.sent).toEqual([]);
  });
});
