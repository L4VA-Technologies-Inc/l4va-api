import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem';

import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { UniswapQuoteService } from '@/modules/vaults/processing-tx/onchain/uniswap-quote.service';

export const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

/** WETH on Robinhood Chain 4663 (see vault-contract-solidity test/fork). */
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;

export enum SwapAdapterKind {
  /** `UniversalRouterSwapAdapter` — typed v3/v4 routes over Uniswap. */
  universalRouter = 'universal_router',
  /** `TestnetSwapAdapter` — fixed `rate[in][out]`, ignores `route`. Testnet only. */
  testnetFixedRate = 'testnet_fixed_rate',
}

/** `UniversalRouterSwapAdapter.RouteKind`. */
const ROUTE_KIND_V3_EXACT_IN = 0;

const TESTNET_SWAP_ADAPTER_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'rate',
    inputs: [
      { name: 'assetIn', type: 'address' },
      { name: 'assetOut', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface SwapQuote {
  amountOut: bigint;
  route: Hex;
}

/**
 * Quotes and routes basket trades for the vault's `swap`-tagged adapter.
 *
 * Quotes are the only price source for index vaults: they value holdings for
 * weight drift and set `minAmountOut`. This keeps stock tokens priced by the
 * market they are actually traded on, and sidesteps the open ERC-8056
 * `uiMultiplier` question for valuation — balances are never rescaled here.
 */
@Injectable()
export class IndexSwapRouteService {
  private readonly logger = new Logger(IndexSwapRouteService.name);
  readonly adapter: Address | null;
  readonly kind: SwapAdapterKind;
  private readonly weth: Address;

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly uniswapQuoteService: UniswapQuoteService,
    configService: ConfigService
  ) {
    const isTestnet = configService.get<string>('CARDANO_NETWORK') !== 'mainnet';
    const adapter = configService.get<string>('EVM_SWAP_ADAPTER_ADDRESS');
    this.adapter = adapter ? (adapter.toLowerCase() as Address) : null;
    this.kind =
      (configService.get<string>('EVM_SWAP_ADAPTER_KIND') as SwapAdapterKind) ??
      (isTestnet ? SwapAdapterKind.testnetFixedRate : SwapAdapterKind.universalRouter);
    this.weth = (configService.get<string>('EVM_WETH_ADDRESS') ?? ROBINHOOD_WETH).toLowerCase() as Address;

    if (!isTestnet && this.kind === SwapAdapterKind.testnetFixedRate) {
      throw new Error('EVM_SWAP_ADAPTER_KIND=testnet_fixed_rate must never be used on mainnet');
    }
  }

  requireAdapter(): Address {
    if (!this.adapter) {
      throw new Error('EVM_SWAP_ADAPTER_ADDRESS is not configured — index vault trades are disabled');
    }
    return this.adapter;
  }

  async quote(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<SwapQuote> {
    if (amountIn === 0n) return { amountOut: 0n, route: '0x' };
    return this.kind === SwapAdapterKind.testnetFixedRate
      ? this.quoteFixedRate(assetIn, assetOut, amountIn)
      : this.quoteUniswapV3(assetIn, assetOut, amountIn);
  }

  /** Native value of `amount` of `asset`, via an exact-input quote into native. */
  async valueInNative(asset: Address, amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    return (await this.quote(asset, NATIVE, amount)).amountOut;
  }

  private async quoteFixedRate(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<SwapQuote> {
    const rate = (await this.contractReader.publicClient.readContract({
      address: this.requireAdapter(),
      abi: TESTNET_SWAP_ADAPTER_ABI,
      functionName: 'rate',
      args: [assetIn, assetOut],
    })) as bigint;
    if (rate === 0n) {
      throw new Error(`TestnetSwapAdapter has no rate for ${assetIn} → ${assetOut}`);
    }
    return { amountOut: (amountIn * rate) / 10n ** 18n, route: '0x' };
  }

  private async quoteUniswapV3(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<SwapQuote> {
    const tokenIn = assetIn === NATIVE ? this.weth : assetIn;
    const tokenOut = assetOut === NATIVE ? this.weth : assetOut;
    // Slippage is applied by the caller against the vault's net floor, so ask for the raw quote.
    const q = await this.uniswapQuoteService.quoteExactInput(tokenIn, tokenOut, amountIn, 0);
    const path = encodePacked(['address', 'uint24', 'address'], [tokenIn, q.fee, tokenOut]);
    const route = encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND_V3_EXACT_IN, path]);
    return { amountOut: q.amountOut, route };
  }
}
