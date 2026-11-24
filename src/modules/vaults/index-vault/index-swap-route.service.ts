import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseError, ContractFunctionRevertedError, formatEther, parseAbi, type Address, type Hex } from 'viem';

import {
  describeRoute,
  encodeMultiPathRoute,
  NATIVE,
  NoSupportedRouteError,
  pathSharesBps,
  planFromTradingApi,
  RouteVenue,
  tradingApiHops,
  v4PoolId,
  validateRoutePlan,
  type RouteHop,
  type RoutePlan,
} from './swap-route/multi-path-route';
import {
  allowedCallerOverride,
  ROUTE_PROBE_ABI,
  ROUTE_PROBE_ADDRESS,
  ROUTE_PROBE_RUNTIME,
} from './swap-route/route-probe';
import { TradingApiUnavailableError, UniswapTradingApiClient } from './swap-route/uniswap-trading-api.client';

import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import {
  findEvmProtocolVersionByFactory,
  resolveVaultSwapAdapter,
  vaultSwapAdapterIsMultiPath,
} from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import {
  allowedPoolIds,
  disallowedPool,
  guardedPoolOf,
  isGuardedSwapAdapter,
} from '@/modules/vaults/processing-tx/onchain/evm-swap-guard';
import { EvmSwapService, type SwapParams } from '@/modules/vaults/processing-tx/onchain/evm-swap.service';
import { UNISWAP_V3_ROBINHOOD } from '@/modules/vaults/processing-tx/onchain/uniswap-quote.service';

export { NATIVE, NoSupportedRouteError };

/** WETH on Robinhood Chain 4663 (see vault-contract-solidity test/fork). */
const ROBINHOOD_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;

export enum SwapAdapterKind {
  /** `UniversalRouterSwapAdapter` — typed v3/v4 routes over Uniswap. */
  universalRouter = 'universal_router',
  /** `TestnetSwapAdapter` — fixed `rate[in][out]`, ignores `route`. Testnet only. */
  testnetFixedRate = 'testnet_fixed_rate',
}

/** Uniswap on Robinhood Chain 4663 (developers.uniswap.org deployments). Other chains set them in env. */
const MAINNET_CHAIN_ID = 4663;
const MAINNET_V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address;
const MAINNET_V4_STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address;
/** USDG on 4663: the stable most memecoin and stock pools pair with. */
const MAINNET_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
/** A missing pool is re-checked after this, so a pool created later is found without a restart. */
const V4_MISSING_POOL_TTL_MS = 10 * 60_000;
const V3_FEE_TIERS = [100, 500, 3000, 10_000];

/** Hookless v4 pools tried when the Trading API is down. The deepest wins. */
const V4_POOL_CANDIDATES: Array<{ fee: number; tickSpacing: number }> = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 2500, tickSpacing: 25 },
  { fee: 2500, tickSpacing: 50 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

/** Route checks for the token picker are cached this long. */
const ROUTE_CHECK_TTL_MS = 15 * 60_000;
/** Default size of the buy probe behind {@link IndexSwapRouteService.checkAsset}: 0.01 ETH. */
const DEFAULT_ROUTE_PROBE_NATIVE = 10n ** 16n;

/** Default round-trip cost above which a token counts as too illiquid for a basket: 25% (matches the swap-pool allowlist). */
const DEFAULT_MAX_ROUND_TRIP_LOSS_BPS = 2500;
/** A buy that arrives more than this short of what the adapter delivered means a transfer tax. */
const TRANSFER_TAX_TOLERANCE_BPS = 10n;

const BPS = 10_000n;

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

const V3_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
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

const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export interface SwapQuote {
  /** Expected output before the vault's trade fee. */
  amountOut: bigint;
  route: Hex;
  /** Null for the testnet fixed-rate adapter, which ignores routes. */
  plan: RoutePlan | null;
}

/** A swap ready for `EvmSwapService.swap`, priced by simulating that exact call. */
export interface PreparedSwap {
  params: SwapParams;
  quote: SwapQuote;
  /** What the vault keeps per the simulation (after its trade fee). */
  simulatedNetOut: bigint;
}

/** Vault fields that pick its swap adapter. A not-yet-deployed vault passes `null` (current version). */
export type VaultRouteRef = { chain_id?: number | string | null; evm_protocol_version?: number | null } | null;

/**
 * `ok`: tradable both ways. `no_route`: no route the adapter can run, or the
 * test trade reverted (e.g. a transfer-taxed token). `illiquid`: tradable, but
 * a small buy-then-sell loses more than the allowed round-trip cost.
 * `unavailable`: Uniswap or the RPC did not answer; nothing is known.
 */
export type RouteCheckStatus = 'ok' | 'no_route' | 'illiquid' | 'unavailable';

export interface RouteCheck {
  status: RouteCheckStatus;
  /** Why it is not `ok`, phrased for users. */
  reason?: string;
  /** Human-readable route, e.g. "v3 WETH→SPY 0.05% › v4 SPY→AMZN 0.05%". */
  route?: string;
  checkedAt: string;
}

export interface AssetRouteCheck {
  /** Overall verdict; a basket token needs `ok`. */
  status: RouteCheckStatus;
  reason?: string;
  buy: RouteCheck;
  sell: RouteCheck;
  /** Cost of buying the probe size with ETH and selling it straight back, in bps. */
  roundTripLossBps?: number;
  checkedAt: string;
}

/** The vault's adapter cannot run the routes the API builds. */
export class SwapAdapterOutdatedError extends Error {
  constructor(readonly adapter: Address | null) {
    super(
      adapter
        ? `This vault's swap adapter (${adapter}) cannot execute multi-hop Uniswap routes; it needs the multi-path adapter.`
        : 'No swap adapter is configured for this vault; trades are disabled.'
    );
    this.name = 'SwapAdapterOutdatedError';
  }
}

/** The encoded route reverted or priced far below its quote when simulated through `Vault.swap`. */
export class SwapSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapSimulationError';
  }
}

/**
 * Quotes and routes trades for the vault's `swap`-tagged adapter.
 *
 * One code path serves every caller (token picker, basket validation, preview,
 * rebalance legs, governance market swaps), so a token the picker allows is a
 * token execution can trade:
 *   1. Ask the Uniswap Trading API for the best v3/v4 route without hooks.
 *   2. Validate it against the adapter's rules (same checks as the contract)
 *      and encode it as `MULTI_PATH_EXACT_IN`.
 *   3. Before sending, simulate `Vault.swap` with that exact route and set
 *      `minAmountOut` from the simulated output ({@link prepareSwap}).
 * If the Trading API is unreachable, single-pool routes found on-chain are used.
 *
 * Quotes also value holdings (weight drift, NAV), so stock tokens are priced by
 * the market they actually trade on; balances are never rescaled here.
 */
@Injectable()
export class IndexSwapRouteService {
  private readonly logger = new Logger(IndexSwapRouteService.name);
  readonly adapter: Address | null;
  readonly kind: SwapAdapterKind;
  private readonly weth: Address;
  private readonly chainId: number;
  private readonly currentFactory: string | null;
  private readonly envAdapterMultiPath: boolean;
  private readonly probeNative: bigint;
  private readonly maxRoundTripLossBps: number;
  /** Null on chains without a configured deployment: that on-chain fallback is skipped. */
  private readonly v3Quoter: Address | null;
  private readonly v4Quoter: Address | null;
  private readonly v4StateView: Address | null;
  /** Intermediate tokens tried when routing only through allowlisted pools. */
  private readonly hubTokens: Address[];

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly tradingApi: UniswapTradingApiClient,
    private readonly swapService: EvmSwapService,
    configService: ConfigService
  ) {
    const isTestnet = configService.get<string>('CARDANO_NETWORK') !== 'mainnet';
    const adapter = configService.get<string>('EVM_SWAP_ADAPTER_ADDRESS');
    this.adapter = adapter ? (adapter.toLowerCase() as Address) : null;
    this.kind =
      (configService.get<string>('EVM_SWAP_ADAPTER_KIND') as SwapAdapterKind) ??
      (isTestnet ? SwapAdapterKind.testnetFixedRate : SwapAdapterKind.universalRouter);
    this.weth = (configService.get<string>('EVM_WETH_ADDRESS') ?? ROBINHOOD_WETH).toLowerCase() as Address;
    this.chainId = Number(configService.get<string>('EVM_CHAIN_ID'));
    this.currentFactory = configService.get<string>('EVM_FACTORY_ADDRESS') ?? null;
    this.envAdapterMultiPath = configService.get<string>('EVM_SWAP_ADAPTER_MULTI_PATH') === 'true';
    const probe = configService.get<string>('INDEX_ROUTE_PROBE_NATIVE_WEI');
    this.probeNative = probe ? BigInt(probe) : DEFAULT_ROUTE_PROBE_NATIVE;
    const maxLoss = Number(configService.get<string>('INDEX_ROUTE_MAX_ROUND_TRIP_LOSS_BPS'));
    this.maxRoundTripLossBps = Number.isFinite(maxLoss) && maxLoss > 0 ? maxLoss : DEFAULT_MAX_ROUND_TRIP_LOSS_BPS;

    const isRobinhoodMainnet = this.chainId === MAINNET_CHAIN_ID;
    const v3Quoter =
      configService.get<string>('EVM_UNISWAP_V3_QUOTER') ?? (isRobinhoodMainnet ? UNISWAP_V3_ROBINHOOD.quoterV2 : null);
    const v4Quoter =
      configService.get<string>('EVM_UNISWAP_V4_QUOTER') ?? (isRobinhoodMainnet ? MAINNET_V4_QUOTER : null);
    const stateView =
      configService.get<string>('EVM_UNISWAP_V4_STATE_VIEW') ?? (isRobinhoodMainnet ? MAINNET_V4_STATE_VIEW : null);
    this.v3Quoter = v3Quoter ? (v3Quoter.toLowerCase() as Address) : null;
    this.v4Quoter = v4Quoter ? (v4Quoter.toLowerCase() as Address) : null;
    this.v4StateView = stateView ? (stateView.toLowerCase() as Address) : null;
    const hubs = configService.get<string>('EVM_ROUTE_HUB_TOKENS');
    this.hubTokens = (hubs ? hubs.split(',') : isRobinhoodMainnet ? [MAINNET_USDG] : [])
      .map(h => h.trim().toLowerCase() as Address)
      .filter(h => /^0x[0-9a-f]{40}$/.test(h));

    if (!isTestnet && this.kind === SwapAdapterKind.testnetFixedRate) {
      throw new Error('EVM_SWAP_ADAPTER_KIND=testnet_fixed_rate must never be used on mainnet');
    }
  }

  // ---------------------------------------------------------------------------
  // Adapters
  // ---------------------------------------------------------------------------

  requireAdapter(): Address {
    if (!this.adapter) {
      throw new Error('EVM_SWAP_ADAPTER_ADDRESS is not configured — index vault trades are disabled');
    }
    return this.adapter;
  }

  /** The adapter this vault must trade through (its protocol version's). */
  requireAdapterFor(vault: NonNullable<VaultRouteRef>): Address {
    const adapter = resolveVaultSwapAdapter(vault, this.adapter);
    if (!adapter) throw new SwapAdapterOutdatedError(null);
    return adapter.toLowerCase() as Address;
  }

  /** Version fields of a vault the current factory would deploy. */
  private currentVersionRef(): NonNullable<VaultRouteRef> {
    const version = findEvmProtocolVersionByFactory(this.chainId, this.currentFactory);
    return { chain_id: this.chainId, evm_protocol_version: version?.version ?? null };
  }

  /**
   * The adapter for `vault` (or for a new vault), checked to run the routes this
   * service builds. Throws {@link SwapAdapterOutdatedError} otherwise.
   */
  tradingAdapterFor(vault: VaultRouteRef): Address {
    const ref = vault ?? this.currentVersionRef();
    const adapter = resolveVaultSwapAdapter(ref, this.adapter);
    if (!adapter) throw new SwapAdapterOutdatedError(null);
    if (this.kind === SwapAdapterKind.universalRouter && !vaultSwapAdapterIsMultiPath(ref, this.envAdapterMultiPath)) {
      throw new SwapAdapterOutdatedError(adapter.toLowerCase() as Address);
    }
    return adapter.toLowerCase() as Address;
  }

  // ---------------------------------------------------------------------------
  // Quotes
  // ---------------------------------------------------------------------------

  /**
   * Best executable route for `amountIn` and its expected output (before the
   * vault fee). Throws {@link NoSupportedRouteError} when no route the adapter
   * can run exists, or {@link TradingApiUnavailableError} when that could not
   * be determined.
   *
   * When `swapper` (default: the configured adapter) is a guarded adapter, only
   * allowlisted pools are used: paths of the Uniswap route through other pools
   * are dropped, and when none is left a route is built on-chain from
   * allowlisted pools only. `ignoreAllowlist` prices at Uniswap's best route
   * instead (valuation, never execution).
   */
  async quote(
    assetIn: Address,
    assetOut: Address,
    amountIn: bigint,
    swapper?: Address,
    opts: { ignoreAllowlist?: boolean } = {}
  ): Promise<SwapQuote> {
    if (amountIn === 0n) return { amountOut: 0n, route: '0x', plan: null };
    assetIn = assetIn.toLowerCase() as Address;
    assetOut = assetOut.toLowerCase() as Address;
    if (this.kind === SwapAdapterKind.testnetFixedRate) return this.quoteFixedRate(assetIn, assetOut, amountIn);

    const adapter = (swapper ?? this.adapter ?? NATIVE).toLowerCase() as Address;
    const guard =
      !opts.ignoreAllowlist && adapter !== NATIVE && (await isGuardedSwapAdapter(this.contractReader.publicClient, adapter))
        ? adapter
        : null;

    let plan: RoutePlan;
    const hints: RouteHop[] = [];
    try {
      plan = await this.planViaTradingApi(assetIn, assetOut, amountIn, adapter, guard, hints);
      if (plan.estimated) plan = await this.requote(plan);
    } catch (err) {
      // Also fall back when the Trading API finds no route: it gives up on sizes deeper than its
      // liquidity threshold (e.g. a vault's whole L4VA balance), while a direct pool still quotes —
      // and that quote is the honest exit value. The on-chain route passes the same validation.
      if (!(err instanceof TradingApiUnavailableError) && !(err instanceof NoSupportedRouteError)) throw err;
      const fallback = guard
        ? await this.planViaAllowlistedPools(assetIn, assetOut, amountIn, guard, hints).catch(() => null)
        : await this.planViaChain(assetIn, assetOut, amountIn);
      if (!fallback) throw err;
      this.logger.warn(
        `${err instanceof TradingApiUnavailableError ? 'Trading API down' : `Trading API route unusable (${err.reason})`}; ` +
          `using on-chain ${guard ? 'allowlisted' : 'single-pool'} route for ${assetIn}→${assetOut}`
      );
      plan = fallback;
    }
    return { amountOut: plan.amountOut, route: encodeMultiPathRoute(plan, this.weth), plan };
  }

  /** Native value of `amount` of `asset`, via an exact-input quote into native. */
  async valueInNative(asset: Address, amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    try {
      return (await this.quote(asset, NATIVE, amount, undefined, { ignoreAllowlist: true })).amountOut;
    } catch (err) {
      // Dust (e.g. 1 wei left after a sale) quotes to zero everywhere and reads as "no route".
      // Value an amount below one whole token from the price of one whole token instead, so a
      // speck of dust can never block pricing a whole portfolio. Real missing routes still throw.
      if (!(err instanceof NoSupportedRouteError)) throw err;
      const decimals = Number(
        await this.contractReader.publicClient
          .readContract({ address: asset, abi: ERC20_META_ABI, functionName: 'decimals' })
          .catch(() => 18)
      );
      const oneToken = 10n ** BigInt(decimals);
      if (amount >= oneToken) throw err;
      const unitValue = (await this.quote(asset, NATIVE, oneToken, undefined, { ignoreAllowlist: true })).amountOut;
      return (amount * unitValue) / oneToken;
    }
  }

  /**
   * Build `Vault.swap` params whose floor comes from simulating that exact call.
   *
   * The quote picks the route; the simulation prices it. The swap is refused
   * when the simulated output falls short of the quote by more than the
   * slippage allowance (bad route data, or a pool that moved), so a trade is
   * never sent on a price we have not checked against the route we encoded.
   */
  async prepareSwap(input: {
    vaultAddress: Address;
    adapter: Address;
    operationId: Hex;
    assetIn: Address;
    assetOut: Address;
    amountIn: bigint;
    deadline: bigint;
    slippageBps: number;
    tradeFeeBps: number;
  }): Promise<PreparedSwap> {
    const quote = await this.quote(input.assetIn, input.assetOut, input.amountIn, input.adapter);
    if (quote.amountOut === 0n) {
      throw new NoSupportedRouteError(input.assetIn, input.assetOut, 'quote rounds to zero output');
    }
    const params: SwapParams = {
      operationId: input.operationId,
      adapter: input.adapter,
      assetIn: input.assetIn,
      amountIn: input.amountIn,
      assetOut: input.assetOut,
      minAmountOut: 1n,
      deadline: input.deadline,
      route: quote.route,
    };

    let simulatedNetOut: bigint;
    try {
      // A floor of 1 so the call returns the full output instead of reverting on it.
      simulatedNetOut = await this.swapService.simulateSwap(input.vaultAddress, { ...params, minAmountOut: 1n });
    } catch (err) {
      throw new SwapSimulationError(`swap simulation reverted: ${(err as Error).message.split('\n')[0]}`);
    }

    const slip = BigInt(BPS) - BigInt(input.slippageBps);
    const expectedNet = (quote.amountOut * (BPS - BigInt(input.tradeFeeBps))) / BPS;
    if (simulatedNetOut * BPS < expectedNet * slip) {
      throw new SwapSimulationError(
        `simulated output ${simulatedNetOut} is more than ${input.slippageBps} bps below the quote ` +
          `(${expectedNet} after fee) for ${input.assetIn}→${input.assetOut}`
      );
    }
    params.minAmountOut = (simulatedNetOut * slip) / BPS;
    if (params.minAmountOut === 0n) {
      throw new NoSupportedRouteError(input.assetIn, input.assetOut, 'output rounds to zero after slippage');
    }
    return { params, quote, simulatedNetOut };
  }

  // ---------------------------------------------------------------------------
  // Route checks (token picker, basket validation)
  // ---------------------------------------------------------------------------

  private readonly routeCheckCache = new Map<string, { at: number; value: AssetRouteCheck }>();

  /**
   * Can `asset` be bought with ETH and sold back to ETH by this vault (or a new
   * vault)? A token passes only when:
   *   1. Uniswap returns a route the adapter accepts, both ways (same quote and
   *      encoding as execution), and
   *   2. buying the probe size and selling it straight back actually executes
   *      through the real adapter on live state ({@link simulateRoundTrip}),
   *      with no transfer tax and a round-trip cost within the limit.
   * Cached for 15 min; `fresh` bypasses the cache (vault / proposal creation).
   */
  async checkAsset(asset: Address, vault: VaultRouteRef = null, fresh = false): Promise<AssetRouteCheck> {
    asset = asset.toLowerCase() as Address;
    const ref = vault ?? this.currentVersionRef();
    const key = `${ref.chain_id}:${ref.evm_protocol_version ?? 'env'}:${asset}`;
    const cached = this.routeCheckCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < ROUTE_CHECK_TTL_MS) return cached.value;

    const value = await this.runAssetCheck(asset, ref);
    if (value.status !== 'unavailable') this.routeCheckCache.set(key, { at: Date.now(), value });
    return value;
  }

  private async runAssetCheck(asset: Address, ref: NonNullable<VaultRouteRef>): Promise<AssetRouteCheck> {
    const checkedAt = new Date().toISOString();
    const verdict = (
      status: RouteCheckStatus,
      reason: string,
      buy?: RouteCheck,
      sell?: RouteCheck
    ): AssetRouteCheck => {
      const same: RouteCheck = { status, reason, checkedAt };
      return { status, reason, buy: buy ?? same, sell: sell ?? same, checkedAt };
    };

    let adapter: Address;
    try {
      adapter = this.tradingAdapterFor(ref);
    } catch (err) {
      return verdict('no_route', (err as Error).message);
    }

    const buyQuote = await this.tryQuote(NATIVE, asset, this.probeNative, adapter);
    if ('status' in buyQuote) return verdict(buyQuote.status, `Cannot buy: ${buyQuote.reason}`);
    const sellQuote = await this.tryQuote(asset, NATIVE, buyQuote.amountOut, adapter);
    const buy: RouteCheck = { status: 'ok', route: await this.describeQuote(buyQuote), checkedAt };
    if ('status' in sellQuote) {
      return verdict(sellQuote.status, `Cannot sell back to ETH: ${sellQuote.reason}`, buy, {
        status: sellQuote.status,
        reason: sellQuote.reason,
        checkedAt,
      });
    }
    const sell: RouteCheck = { status: 'ok', route: await this.describeQuote(sellQuote), checkedAt };

    // The testnet fixed-rate adapter ignores routes; there is nothing more to prove.
    if (this.kind !== SwapAdapterKind.universalRouter) return { status: 'ok', buy, sell, checkedAt };

    // A guarded adapter only trades through pools the Safe allowlisted.
    const client = this.contractReader.publicClient;
    const [buyPool, sellPool] = await Promise.all([
      disallowedPool(client, adapter, buyQuote.route),
      disallowedPool(client, adapter, sellQuote.route),
    ]);
    if (buyPool || sellPool) {
      const reason = `the Uniswap route uses a pool not yet approved for vault trading (${buyPool ?? sellPool})`;
      return verdict('no_route', reason, buy, { status: 'no_route', reason, checkedAt });
    }

    const trip = await this.simulateRoundTrip(adapter, asset, this.probeNative, buyQuote.route, sellQuote.route);
    if (trip.kind === 'unavailable') return verdict('unavailable', trip.reason, buy, sell);
    if (trip.kind === 'reverted') {
      const reason = `a test buy and sell through Uniswap failed (${trip.reason}); the token may charge a transfer fee`;
      return verdict('no_route', reason, buy, { status: 'no_route', reason, checkedAt });
    }
    if (trip.kind !== 'ok') return verdict('unavailable', trip.reason, buy, sell);
    const r = trip.result;
    if (r.boughtReceived * BPS < r.boughtReported * (BPS - TRANSFER_TAX_TOLERANCE_BPS)) {
      return verdict('no_route', 'the token charges a fee on transfers, which the vault cannot trade', buy, sell);
    }
    // Cost of getting in and out. The quotes price the buy and the later sell against today's
    // pools independently — what a vault pays when it buys now and sells at a later rebalance.
    // The probe sells straight back into the liquidity its own buy just used, so on a thin pool
    // it can look cheap when it is not; it only counts when it is the worse of the two.
    const spreadBps = Number(((this.probeNative - sellQuote.amountOut) * BPS) / this.probeNative);
    const probeLossBps = Number(((this.probeNative - r.soldReceived) * BPS) / this.probeNative);
    const lossBps = Math.max(spreadBps, probeLossBps);
    if (lossBps > this.maxRoundTripLossBps) {
      return {
        ...verdict(
          'illiquid',
          `liquidity is too thin: ${formatEther(this.probeNative)} ETH of it sells back for ` +
            `${(lossBps / 100).toFixed(1)}% less at current prices (limit ${(this.maxRoundTripLossBps / 100).toFixed(1)}%)`,
          buy,
          sell
        ),
        roundTripLossBps: lossBps,
      };
    }
    return { status: 'ok', buy, sell, roundTripLossBps: Math.max(lossBps, 0), checkedAt };
  }

  private async tryQuote(
    assetIn: Address,
    assetOut: Address,
    amountIn: bigint,
    adapter: Address
  ): Promise<SwapQuote | { status: RouteCheckStatus; reason: string }> {
    try {
      const q = await this.quote(assetIn, assetOut, amountIn, adapter);
      if (q.amountOut === 0n) return { status: 'no_route', reason: 'Uniswap quotes zero output' };
      return q;
    } catch (err) {
      if (err instanceof NoSupportedRouteError) return { status: 'no_route', reason: err.reason };
      return { status: 'unavailable', reason: 'Uniswap could not be reached; try again shortly' };
    }
  }

  private async describeQuote(q: SwapQuote): Promise<string | undefined> {
    return q.plan ? this.describe(q.plan).catch(() => undefined) : undefined;
  }

  /**
   * Buy `token` with `amountIn` ETH and sell it straight back through `adapter`,
   * inside one `eth_call`: `RouteProbe` code is placed at a scratch address with
   * ETH, and that address is allow-listed on the adapter, for this call only.
   */
  private async simulateRoundTrip(
    adapter: Address,
    token: Address,
    amountIn: bigint,
    buyRoute: Hex,
    sellRoute: Hex
  ): Promise<
    | {
        kind: 'ok';
        result: { boughtReported: bigint; boughtReceived: bigint; soldReported: bigint; soldReceived: bigint };
      }
    | { kind: 'reverted' | 'unavailable'; reason: string }
  > {
    const allow = allowedCallerOverride(ROUTE_PROBE_ADDRESS);
    try {
      const { result } = await this.contractReader.publicClient.simulateContract({
        address: ROUTE_PROBE_ADDRESS,
        abi: ROUTE_PROBE_ABI,
        functionName: 'roundTrip',
        args: [adapter, token, amountIn, buyRoute, sellRoute, BigInt(Math.floor(Date.now() / 1000) + 600)],
        stateOverride: [
          { address: ROUTE_PROBE_ADDRESS, code: ROUTE_PROBE_RUNTIME, balance: amountIn * 2n },
          { address: adapter, stateDiff: [allow] },
        ],
      });
      return { kind: 'ok', result: result as any };
    } catch (err) {
      const reverted = (err as BaseError).walk?.(e => e instanceof ContractFunctionRevertedError) as
        | ContractFunctionRevertedError
        | null
        | undefined;
      if (reverted) {
        const name = reverted.data?.errorName ?? reverted.signature ?? reverted.reason ?? 'reverted';
        return { kind: 'reverted', reason: `reverted: ${String(name).slice(0, 120)}` };
      }
      this.logger.warn(`Round-trip probe for ${token} could not run: ${(err as Error).message.split('\n')[0]}`);
      return { kind: 'unavailable', reason: 'the chain could not be reached to test-trade it; try again shortly' };
    }
  }

  /** Human-readable route with token symbols. */
  async describe(plan: RoutePlan): Promise<string> {
    const tokens = new Set<Address>();
    plan.paths.forEach(p => p.hops.forEach(h => tokens.add(h.tokenIn).add(h.tokenOut)));
    await Promise.all([...tokens].map(t => this.symbol(t)));
    return describeRoute(plan, a => this.symbolCache.get(a.toLowerCase()) ?? `${a.slice(0, 6)}…`);
  }

  private readonly symbolCache = new Map<string, string>();

  private async symbol(token: Address): Promise<void> {
    const key = token.toLowerCase();
    if (this.symbolCache.has(key)) return;
    if (key === NATIVE) {
      this.symbolCache.set(key, 'ETH');
      return;
    }
    const s = await this.contractReader.publicClient
      .readContract({ address: token, abi: ERC20_META_ABI, functionName: 'symbol' })
      .catch(() => null);
    if (s) this.symbolCache.set(key, String(s));
  }

  // ---------------------------------------------------------------------------
  // Route sources
  // ---------------------------------------------------------------------------

  /**
   * Uniswap's best route, minus the paths the adapter cannot run. With `guard`, paths through pools
   * that adapter has not allowlisted are dropped too. Every hop Uniswap considered is pushed to
   * `hints`, so an on-chain fallback can try those pools.
   */
  private async planViaTradingApi(
    assetIn: Address,
    assetOut: Address,
    amountIn: bigint,
    swapper: Address,
    guard: Address | null = null,
    hints: RouteHop[] = []
  ): Promise<RoutePlan> {
    if (!this.tradingApi.enabled) throw new TradingApiUnavailableError('UNISWAP_API_KEY is not configured');
    const resp = await this.tradingApi.quoteExactInput(assetIn, assetOut, amountIn, swapper);
    if ('noRoute' in resp) {
      throw new NoSupportedRouteError(assetIn, assetOut, `Uniswap has no route (${resp.detail})`);
    }
    const hops = tradingApiHops(resp, this.weth);
    hints.push(...hops);
    let disallowed: ((path: RouteHop[]) => Hex | null) | undefined;
    if (guard) {
      const allowed = await allowedPoolIds(
        this.contractReader.publicClient,
        guard,
        hops.map(h => guardedPoolOf(h).id)
      );
      if (allowed) {
        disallowed = path => {
          const bad = path.map(h => guardedPoolOf(h).id).find(id => !allowed.has(id.toLowerCase()));
          return bad ?? null;
        };
      }
    }
    return planFromTradingApi(resp, assetIn, assetOut, amountIn, this.weth, { disallowedPool: disallowed });
  }

  /**
   * Re-price a plan whose paths were partly dropped: each kept path gets its share of the input
   * (as the adapter splits it) and is quoted hop by hop on-chain. Left as an estimate when a
   * quoter is missing or a hop cannot be quoted; execution simulates the route anyway.
   */
  private async requote(plan: RoutePlan): Promise<RoutePlan> {
    const shares = pathSharesBps(plan.paths);
    let rest = plan.amountIn;
    const amounts = shares.map((bps, i) => {
      const a = i === shares.length - 1 ? rest : (plan.amountIn * BigInt(bps)) / BPS;
      rest -= a;
      return a;
    });
    try {
      const outs = await Promise.all(plan.paths.map((p, i) => this.quotePath(p.hops, amounts[i])));
      if (outs.some(o => o === 0n)) return plan;
      return {
        ...plan,
        amountOut: outs.reduce((s, o) => s + o, 0n),
        paths: plan.paths.map((p, i) => ({ ...p, amountIn: amounts[i], amountOut: outs[i] })),
        estimated: false,
      };
    } catch (err) {
      this.logger.warn(`Could not re-quote a trimmed route on-chain: ${(err as Error).message.split('\n')[0]}`);
      return plan;
    }
  }

  /** Output of `hops` for `amountIn`, one pool at a time with Uniswap's quoters. */
  private async quotePath(hops: RouteHop[], amountIn: bigint): Promise<bigint> {
    let amount = amountIn;
    for (const h of hops) {
      if (amount === 0n) return 0n;
      amount = await this.quoteHop(h, amount);
    }
    return amount;
  }

  private async quoteHop(h: RouteHop, amountIn: bigint): Promise<bigint> {
    const client = this.contractReader.publicClient;
    if (h.venue === RouteVenue.v3) {
      if (!this.v3Quoter) throw new Error('no v3 quoter configured');
      const { result } = await client.simulateContract({
        address: this.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: h.tokenIn, tokenOut: h.tokenOut, amountIn, fee: h.fee, sqrtPriceLimitX96: 0n }],
      });
      return (result as readonly [bigint, bigint, number, bigint])[0];
    }
    if (!this.v4Quoter) throw new Error('no v4 quoter configured');
    const a = h.tokenIn.toLowerCase() as Address;
    const b = h.tokenOut.toLowerCase() as Address;
    const [currency0, currency1] = a < b ? [a, b] : [b, a];
    const { result } = await client.simulateContract({
      address: this.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: { currency0, currency1, fee: h.fee, tickSpacing: h.tickSpacing, hooks: NATIVE },
          zeroForOne: a === currency0,
          exactAmount: amountIn,
          hookData: '0x',
        },
      ],
    });
    return (result as readonly [bigint, bigint])[0];
  }

  /**
   * Best single path through pools the guarded adapter allowlists: direct, or through one hub token
   * (USDG on mainnet). Candidate pools are the ones Uniswap used in its quote (`hints`) plus the
   * standard v3 tiers and v4 keys. Null when no allowlisted path quotes.
   */
  private async planViaAllowlistedPools(
    assetIn: Address,
    assetOut: Address,
    amountIn: bigint,
    adapter: Address,
    hints: RouteHop[]
  ): Promise<RoutePlan | null> {
    const asV3 = (t: Address) => (t === NATIVE ? this.weth : t);
    const candidates = (a: Address, b: Address): RouteHop[] => {
      const pair = [asV3(a), asV3(b)].sort().join();
      const out: RouteHop[] = [];
      for (const h of hints) {
        if ([asV3(h.tokenIn), asV3(h.tokenOut)].sort().join() !== pair) continue;
        // Orient the hint a → b, keeping the currencies its pool really holds.
        const forward = asV3(h.tokenIn) === asV3(a);
        out.push(forward ? h : { ...h, tokenIn: h.tokenOut, tokenOut: h.tokenIn });
      }
      for (const fee of V3_FEE_TIERS) {
        out.push({ venue: RouteVenue.v3, tokenIn: asV3(a), tokenOut: asV3(b), fee, tickSpacing: 0 });
      }
      for (const c of V4_POOL_CANDIDATES) {
        out.push({ venue: RouteVenue.v4, tokenIn: a, tokenOut: b, fee: c.fee, tickSpacing: c.tickSpacing });
      }
      const seen = new Set<string>();
      return out.filter(h => {
        const id = guardedPoolOf(h).id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    };

    const legs: Array<[Address, Address]> = [[assetIn, assetOut]];
    const hubs = this.hubTokens.filter(
      h => !sameAddress(h, asV3(assetIn)) && !sameAddress(h, asV3(assetOut))
    );
    for (const hub of hubs) legs.push([assetIn, hub], [hub, assetOut]);
    const byLeg = legs.map(([a, b]) => candidates(a, b));
    const allowed = await allowedPoolIds(
      this.contractReader.publicClient,
      adapter,
      byLeg.flat().map(h => guardedPoolOf(h).id)
    );
    if (!allowed) return null;
    const usable = byLeg.map(hops => hops.filter(h => allowed.has(guardedPoolOf(h).id.toLowerCase())));

    /** Best hop of `hops` for `amount`, or null. */
    const best = async (hops: RouteHop[], amount: bigint) => {
      const quoted = await Promise.all(
        hops.map(h =>
          this.quoteHop(h, amount)
            .then(out => ({ hop: h, out }))
            .catch(() => null)
        )
      );
      return quoted
        .filter((q): q is { hop: RouteHop; out: bigint } => q !== null && q.out > 0n)
        .sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0))[0] ?? null;
    };

    const options: Array<{ hops: RouteHop[]; out: bigint }> = [];
    const direct = await best(usable[0], amountIn);
    if (direct) options.push({ hops: [direct.hop], out: direct.out });
    for (let i = 0; i < hubs.length; i++) {
      const first = await best(usable[1 + 2 * i], amountIn);
      if (!first) continue;
      const second = await best(usable[2 + 2 * i], first.out);
      if (second) options.push({ hops: [first.hop, second.hop], out: second.out });
    }

    for (const o of options.sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0))) {
      try {
        validateRoutePlan([{ hops: o.hops }], assetIn, assetOut, this.weth);
      } catch {
        continue;
      }
      return {
        assetIn,
        assetOut,
        amountIn,
        amountOut: o.out,
        source: 'onchain',
        paths: [{ amountIn, amountOut: o.out, hops: o.hops }],
      };
    }
    return null;
  }

  /** Best single pool (v3 any tier, or hookless v4) priced by Uniswap's on-chain quoters. */
  private async planViaChain(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<RoutePlan | null> {
    const [v3, v4] = await Promise.all([
      this.quoteV3Single(assetIn, assetOut, amountIn).catch(() => null),
      this.quoteV4Single(assetIn, assetOut, amountIn).catch(() => null),
    ]);
    const best = [v3, v4]
      .filter((p): p is RoutePlan => p !== null)
      .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
    return best ?? null;
  }

  private async quoteV3Single(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<RoutePlan | null> {
    if (!this.v3Quoter) return null;
    const tokenIn = assetIn === NATIVE ? this.weth : assetIn;
    const tokenOut = assetOut === NATIVE ? this.weth : assetOut;
    let best: { fee: number; out: bigint } | null = null;
    for (const fee of V3_FEE_TIERS) {
      const out = await this.contractReader.publicClient
        .simulateContract({
          address: this.v3Quoter,
          abi: V3_QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        })
        .then(r => (r.result as readonly [bigint, bigint, number, bigint])[0])
        .catch(() => 0n);
      if (out > 0n && (!best || out > best.out)) best = { fee, out };
    }
    if (!best) return null;
    return {
      assetIn,
      assetOut,
      amountIn,
      amountOut: best.out,
      source: 'onchain',
      paths: [
        {
          amountIn,
          amountOut: best.out,
          hops: [{ venue: RouteVenue.v3, tokenIn, tokenOut, fee: best.fee, tickSpacing: 0 }],
        },
      ],
    };
  }

  /** Pool keys per pair, picked once (deepest hookless candidate). */
  private readonly v4PoolCache = new Map<string, { pool: { fee: number; tickSpacing: number } | null; at: number }>();

  private async quoteV4Single(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<RoutePlan | null> {
    if (!this.v4StateView || !this.v4Quoter) return null;
    const [currency0, currency1] = assetIn < assetOut ? [assetIn, assetOut] : [assetOut, assetIn];
    const cacheKey = `${currency0}:${currency1}`;
    let cached = this.v4PoolCache.get(cacheKey);
    if (!cached || (!cached.pool && Date.now() - cached.at >= V4_MISSING_POOL_TTL_MS)) {
      let best: { fee: number; tickSpacing: number; liquidity: bigint } | null = null;
      for (const c of V4_POOL_CANDIDATES) {
        const liquidity = (await this.contractReader.publicClient
          .readContract({
            address: this.v4StateView,
            abi: STATE_VIEW_ABI,
            functionName: 'getLiquidity',
            args: [v4PoolId(currency0, currency1, c.fee, c.tickSpacing)],
          })
          .catch(() => 0n)) as bigint;
        if (liquidity > 0n && (!best || liquidity > best.liquidity)) best = { ...c, liquidity };
      }
      cached = { pool: best ? { fee: best.fee, tickSpacing: best.tickSpacing } : null, at: Date.now() };
      this.v4PoolCache.set(cacheKey, cached);
    }
    if (!cached.pool) return null;

    const { fee, tickSpacing } = cached.pool;
    const { result } = await this.contractReader.publicClient.simulateContract({
      address: this.v4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: { currency0, currency1, fee, tickSpacing, hooks: NATIVE },
          zeroForOne: assetIn === currency0,
          exactAmount: amountIn,
          hookData: '0x',
        },
      ],
    });
    const [amountOut] = result as readonly [bigint, bigint];
    if (amountOut === 0n) return null;
    return {
      assetIn,
      assetOut,
      amountIn,
      amountOut,
      source: 'onchain',
      paths: [
        {
          amountIn,
          amountOut,
          hops: [{ venue: RouteVenue.v4, tokenIn: assetIn, tokenOut: assetOut, fee, tickSpacing }],
        },
      ],
    };
  }

  private async quoteFixedRate(assetIn: Address, assetOut: Address, amountIn: bigint): Promise<SwapQuote> {
    const rate = (await this.contractReader.publicClient.readContract({
      address: this.requireAdapter(),
      abi: TESTNET_SWAP_ADAPTER_ABI,
      functionName: 'rate',
      args: [assetIn, assetOut],
    })) as bigint;
    if (rate === 0n) {
      throw new NoSupportedRouteError(assetIn, assetOut, 'the testnet swap adapter has no rate for this pair');
    }
    return { amountOut: (amountIn * rate) / 10n ** 18n, route: '0x', plan: null };
  }
}
