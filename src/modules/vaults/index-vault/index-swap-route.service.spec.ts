import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BaseError, ContractFunctionRevertedError, type Address } from 'viem';

import {
  IndexSwapRouteService,
  NATIVE,
  NoSupportedRouteError,
  SwapAdapterOutdatedError,
  SwapSimulationError,
} from './index-swap-route.service';
import * as amznToEth from './swap-route/__fixtures__/amzn-to-eth.v4-v3.json';
import * as ethToAmzn from './swap-route/__fixtures__/eth-to-amzn.v3-v4.json';
import { ROUTE_PROBE_ABI } from './swap-route/route-probe';
import { TradingApiUnavailableError } from './swap-route/uniswap-trading-api.client';

const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54' as Address;
const ADAPTER = '0x3a25408d952f91e42f39587820bee5f051f4556c' as Address;
const VAULT = '0x808e856d3d68fbfc515db700f3cffef37b6f4906' as Address;
const PROBE = 10n ** 16n;

/** The buy quoted in the fixture: 3577141523813693 wei in, 28272311818779078 AMZN out. */
const BUY_OUT = 28272311818779078n;

function makeService(env: Record<string, string> = {}) {
  const config = {
    get: (k: string) =>
      ({
        CARDANO_NETWORK: 'mainnet',
        EVM_CHAIN_ID: '4663',
        EVM_SWAP_ADAPTER_ADDRESS: ADAPTER,
        EVM_SWAP_ADAPTER_KIND: 'universal_router',
        EVM_SWAP_ADAPTER_MULTI_PATH: 'true',
        ...env,
      })[k],
  };
  const quoteExactInput = jest.fn<(...args: any[]) => Promise<any>>();
  const tradingApi = { enabled: true, quoteExactInput };
  const simulateContract = jest.fn<(...args: any[]) => Promise<any>>();
  const readContract = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue('TKN');
  const simulateSwap = jest.fn<(...args: any[]) => Promise<bigint>>();
  const service = new IndexSwapRouteService(
    { publicClient: { simulateContract, readContract } } as any,
    tradingApi as any,
    { simulateSwap } as any,
    config as any
  );
  return { service, quoteExactInput, simulateContract, simulateSwap };
}

const probeResult = (
  r: Partial<Record<'boughtReported' | 'boughtReceived' | 'soldReported' | 'soldReceived', bigint>>
) => ({
  result: {
    boughtReported: BUY_OUT,
    boughtReceived: BUY_OUT,
    soldReported: PROBE,
    soldReceived: PROBE,
    ...r,
  },
});

describe('IndexSwapRouteService', () => {
  describe('prepareSwap', () => {
    const input = {
      vaultAddress: VAULT,
      adapter: ADAPTER,
      operationId: `0x${'11'.repeat(32)}` as const,
      assetIn: NATIVE,
      assetOut: AMZN,
      amountIn: 3577141523813693n,
      deadline: 1_900_000_000n,
      slippageBps: 100,
      tradeFeeBps: 0,
    };

    it('sets the floor from simulating the exact encoded swap, not from the quote', async () => {
      const { service, quoteExactInput, simulateSwap } = makeService();
      quoteExactInput.mockResolvedValue(ethToAmzn);
      simulateSwap.mockResolvedValue(BUY_OUT - 1000n);

      const { params, simulatedNetOut } = await service.prepareSwap(input);

      const simulated = simulateSwap.mock.calls[0][1] as any;
      expect(simulated.route).toBe(params.route);
      expect(simulated.minAmountOut).toBe(1n);
      expect(simulatedNetOut).toBe(BUY_OUT - 1000n);
      expect(params.minAmountOut).toBe(((BUY_OUT - 1000n) * 9900n) / 10_000n);
    });

    it('refuses to send when the simulation prices the route below the quote by more than the slippage', async () => {
      const { service, quoteExactInput, simulateSwap } = makeService();
      quoteExactInput.mockResolvedValue(ethToAmzn);
      simulateSwap.mockResolvedValue((BUY_OUT * 97n) / 100n);
      await expect(service.prepareSwap(input)).rejects.toBeInstanceOf(SwapSimulationError);
    });

    it('refuses to send when the simulation reverts', async () => {
      const { service, quoteExactInput, simulateSwap } = makeService();
      quoteExactInput.mockResolvedValue(ethToAmzn);
      simulateSwap.mockRejectedValue(new Error('execution reverted'));
      await expect(service.prepareSwap(input)).rejects.toBeInstanceOf(SwapSimulationError);
    });

    it('reports a missing route as NoSupportedRouteError, without simulating', async () => {
      const { service, quoteExactInput, simulateSwap } = makeService();
      quoteExactInput.mockResolvedValue({ noRoute: true, detail: 'No quotes available' });
      await expect(service.prepareSwap(input)).rejects.toBeInstanceOf(NoSupportedRouteError);
      expect(simulateSwap).not.toHaveBeenCalled();
    });
  });

  describe('tradingAdapterFor', () => {
    it('rejects an adapter that predates MULTI_PATH_EXACT_IN', () => {
      const { service } = makeService({ EVM_SWAP_ADAPTER_MULTI_PATH: 'false' });
      expect(() => service.tradingAdapterFor(null)).toThrow(SwapAdapterOutdatedError);
    });
  });

  describe('checkAsset', () => {
    let ctx: ReturnType<typeof makeService>;
    beforeEach(() => {
      ctx = makeService();
      ctx.quoteExactInput.mockImplementation(async (tokenIn: unknown) =>
        String(tokenIn).toLowerCase() === NATIVE ? ethToAmzn : amznToEth
      );
    });

    it('is ok when both routes exist and the round trip executes cheaply', async () => {
      // The sell fixture was recorded for 1 AMZN; scale it to what the probe buy returns.
      const sell = JSON.parse(JSON.stringify(amznToEth));
      sell.quote.output.amount = String((PROBE * 997n) / 1000n);
      sell.quote.route[0][1].amountOut = sell.quote.output.amount;
      ctx.quoteExactInput.mockImplementation(async (tokenIn: unknown) =>
        String(tokenIn).toLowerCase() === NATIVE ? ethToAmzn : sell
      );
      ctx.simulateContract.mockResolvedValue(probeResult({ soldReceived: (PROBE * 998n) / 1000n }));
      const check = await ctx.service.checkAsset(AMZN, null, true);
      expect(check.status).toBe('ok');
      expect(check.roundTripLossBps).toBe(30);
      // The probe runs the routes the quotes produced, through the vault's adapter.
      const call = ctx.simulateContract.mock.calls[0][0] as any;
      expect(call.args[0]).toBe(ADAPTER);
      expect(call.stateOverride).toHaveLength(2);
    });

    it('is illiquid when the round trip loses more than the limit', async () => {
      ctx.simulateContract.mockResolvedValue(probeResult({ soldReceived: (PROBE * 94n) / 100n }));
      const check = await ctx.service.checkAsset(AMZN, null, true);
      expect(check.status).toBe('illiquid');
      expect(check.reason).toMatch(/6.0% less/);
    });

    it('is illiquid when selling at current prices returns far less than the buy cost, even if the probe looks cheap', async () => {
      // A one-sided pool: the probe sells back into its own buy's liquidity and loses little,
      // but the live sell quote (what a later rebalance would get) is 95% lower.
      const thinSell = JSON.parse(JSON.stringify(amznToEth));
      thinSell.quote.output.amount = String(PROBE / 20n);
      thinSell.quote.route[0][1].amountOut = String(PROBE / 20n);
      ctx.quoteExactInput.mockImplementation(async (tokenIn: unknown) =>
        String(tokenIn).toLowerCase() === NATIVE ? ethToAmzn : thinSell
      );
      ctx.simulateContract.mockResolvedValue(probeResult({ soldReceived: (PROBE * 996n) / 1000n }));
      const check = await ctx.service.checkAsset(AMZN, null, true);
      expect(check.status).toBe('illiquid');
      expect(check.roundTripLossBps).toBe(9500);
    });

    it('is no_route when the test trade reverts (e.g. a transfer-taxed token)', async () => {
      const reverted = new ContractFunctionRevertedError({
        abi: ROUTE_PROBE_ABI as any,
        functionName: 'roundTrip',
        data: '0x3f68539a',
      });
      ctx.simulateContract.mockRejectedValue(new BaseError('call reverted', { cause: reverted }));
      const check = await ctx.service.checkAsset(AMZN, null, true);
      expect(check.status).toBe('no_route');
      expect(check.reason).toMatch(/test buy and sell/);
    });

    it('is no_route when the bought tokens arrive short (transfer fee)', async () => {
      ctx.simulateContract.mockResolvedValue(probeResult({ boughtReceived: (BUY_OUT * 95n) / 100n }));
      expect((await ctx.service.checkAsset(AMZN, null, true)).status).toBe('no_route');
    });

    it('is unavailable (and not cached) when Uniswap cannot be reached', async () => {
      ctx.quoteExactInput.mockRejectedValue(new TradingApiUnavailableError('down'));
      expect((await ctx.service.checkAsset(AMZN, null, true)).status).toBe('unavailable');
      ctx.quoteExactInput.mockImplementation(async (tokenIn: unknown) =>
        String(tokenIn).toLowerCase() === NATIVE ? ethToAmzn : amznToEth
      );
      ctx.simulateContract.mockResolvedValue(probeResult({}));
      expect((await ctx.service.checkAsset(AMZN)).status).toBe('ok');
    });

    it('is no_route for every token when the adapter predates multi-path routes', async () => {
      const { service, quoteExactInput } = makeService({ EVM_SWAP_ADAPTER_MULTI_PATH: 'false' });
      const check = await service.checkAsset(AMZN, null, true);
      expect(check.status).toBe('no_route');
      expect(check.reason).toMatch(/multi-path adapter/);
      expect(quoteExactInput).not.toHaveBeenCalled();
    });
  });
});
