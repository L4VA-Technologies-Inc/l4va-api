import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from 'viem';

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
const ROUTE_KIND_V4_EXACT_IN_SINGLE = 1;

/** Uniswap v4 on Robinhood Chain 4663 (developers.uniswap.org v4 deployments). Other chains set them in env. */
const MAINNET_CHAIN_ID = 4663;
const MAINNET_V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address;
const MAINNET_V4_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address;
/** A missing pool is re-checked after this, so a pool created later is found without a restart. */
const V4_MISSING_POOL_TTL_MS = 10 * 60_000;
const NO_HOOKS = NATIVE;

/**
 * Hookless v4 tiers probed when a token has no v3 pool (e.g. L4VA, whose only
 * liquidity is the ETH/L4VA 0.25% / tickSpacing 25 pool). The deepest wins.
 */
const V4_POOL_CANDIDATES: Array<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 2500, tickSpacing: 25 },
  { fee: 2500, tickSpacing: 50 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ type: 'uint128' }],
  },
] as const;

type V4PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

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
  /** Null on chains without a configured v4 deployment: the v4 fallback is then skipped. */
  private readonly v4Quoter: Address | null;
  private readonly v4StateView: Address | null;

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
    const isRobinhoodMainnet = Number(configService.get<string>('EVM_CHAIN_ID')) === MAINNET_CHAIN_ID;
    const quoter =
      configService.get<string>('EVM_UNISWAP_V4_QUOTER') ?? (isRobinhoodMainnet ? MAINNET_V4_QUOTER : null);
    const stateView =
      configService.get<string>('EVM_UNISWAP_V4_STATE_VIEW') ?? (isRobinhoodMainnet ? MAINNET_V4_STATE_VIEW : null);
    this.v4Quoter = quoter ? (quoter.toLowerCase() as Address) : null;
    this.v4StateView = stateView ? (stateView.toLowerCase() as Address) : null;

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
    if (this.kind === SwapAdapterKind.testnetFixedRate) return this.quoteFixedRate(assetIn, assetOut, amountIn);
    // Quote both venues and take the better output: a thin v3 pool must not win
    // over a deep v4 one. Some tokens only trade on v4 (L4VA on Robinhood); the
    // adapter routes V4_EXACT_IN_SINGLE natively.
    const [v3, v4] = await Promise.allSettled([
      this.quoteUniswapV3(assetIn, assetOut, amountIn),
      this.quoteUniswapV4(assetIn, assetOut, amountIn),
    ]);
    const v3Quote = v3.status === 'fulfilled' ? v3.value : null;
    const v4Quote = v4.status === 'fulfilled' ? v4.value : null;
    if (v3Quote && v4Quote) return v4Quote.amountOut > v3Quote.amountOut ? v4Quote : v3Quote;
    if (v3Quote || v4Quote) return v3Quote ?? v4Quote;
    throw v3.status === 'rejected' ? v3.reason : new Error('No Uniswap route');
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

  /** Pool keys per pair, picked once (deepest hookless candidate). */
  private readonly v4PoolCache = new Map<string, { key: V4PoolKey | null; checkedAt: number }>();

  private async findV4Pool(a: Address, b: Address): Promise<V4PoolKey | null> {
    if (!this.v4StateView) return null;
    const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const cacheKey = `${currency0}:${currency1}`.toLowerCase();
    const cached = this.v4PoolCache.get(cacheKey);
    if (cached && (cached.key || Date.now() - cached.checkedAt < V4_MISSING_POOL_TTL_MS)) return cached.key;

    let best: { key: V4PoolKey; liquidity: bigint } | null = null;
    for (const { fee, tickSpacing } of V4_POOL_CANDIDATES) {
      const key: V4PoolKey = { currency0, currency1, fee, tickSpacing, hooks: NO_HOOKS };
      const poolId = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
          [currency0, currency1, fee, tickSpacing, NO_HOOKS]
        )
      );
      const liquidity = (await this.contractReader.publicClient
        .readContract({ address: this.v4StateView, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] })
        .catch(() => 0n)) as bigint;
      if (liquidity > 0n && (!best || liquidity > best.liquidity)) best = { key, liquidity };
    }
    this.v4PoolCache.set(cacheKey, { key: best?.key ?? null, checkedAt: Date.now() });
    return best?.key ?? null;
  }

  /** Single-hop v4 quote; native stays `address(0)` (no wrapping on v4). */
  private async quoteUniswapV4(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<SwapQuote | null> {
    const key = await this.findV4Pool(assetIn, assetOut);
    if (!key || !this.v4Quoter) return null;
    const zeroForOne = assetIn.toLowerCase() === key.currency0.toLowerCase();
    const { result } = await this.contractReader.publicClient.simulateContract({
      address: this.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    });
    const [amountOut] = result as readonly [bigint, bigint];
    const data = encodeAbiParameters(
      [{ type: 'tuple', components: POOL_KEY_COMPONENTS }, { type: 'bool' }],
      [key, zeroForOne]
    );
    const route = encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes' }], [ROUTE_KIND_V4_EXACT_IN_SINGLE, data]);
    return { amountOut, route };
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
