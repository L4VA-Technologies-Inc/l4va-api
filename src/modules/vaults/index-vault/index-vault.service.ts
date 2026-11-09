import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, IsNull, Not, Repository } from 'typeorm';
import { encodeAbiParameters, formatUnits, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';

import {
  computeAllocation,
  computeNav,
  planBuys,
  planSells,
  validateWeights,
  type HoldingValue,
  type PlanOptions,
  type PortfolioState,
  type SkippedLeg,
  type WeightTarget,
} from './index-rebalance.planner';
import {
  computeNextRebalanceAt,
  nextRunAfterConfigChange,
  resolveSchedule,
  type ResolvedSchedule,
} from './index-rebalance.schedule';
import {
  IndexSwapRouteService,
  NATIVE,
  NoSupportedRouteError,
  SwapAdapterOutdatedError,
  type AssetRouteCheck,
  type VaultRouteRef,
} from './index-swap-route.service';

import { EvmIndexRebalance, IndexRebalancePhase } from '@/database/evm-index-rebalance.entity';
import { Proposal } from '@/database/proposal.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { PriceService } from '@/modules/price/price.service';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { EvmLiquidityService } from '@/modules/vaults/processing-tx/onchain/evm-liquidity.service';
import { EvmAssetKind } from '@/modules/vaults/processing-tx/onchain/evm-position.service';
import { EvmSwapService, SwapNotBroadcastError } from '@/modules/vaults/processing-tx/onchain/evm-swap.service';
import { VAULT_ABI } from '@/modules/vaults/processing-tx/onchain/vault.abi';
import {
  INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
  INDEX_DEFAULT_SLIPPAGE_BPS,
  INDEX_MAX_ASSETS,
  INDEX_MIN_WEIGHT_BPS,
  IndexConfig,
  IndexLegSide,
  IndexLegStatus,
  IndexRebalanceLeg,
  IndexRebalanceSkippedLeg,
  IndexRebalanceSkipReason,
  IndexRebalanceStatus,
  IndexRebalanceTrigger,
  IndexScheduleInput,
  IndexTarget,
  VaultArchetype,
} from '@/types/index-vault.types';
import { MarketplaceAction } from '@/types/proposal.types';
import { ChainType, VaultStatus } from '@/types/vault.types';

const ERC20_METADATA_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]);

/** A 0.001 ETH leg is not worth its gas. */
const MIN_TRADE_NATIVE = 10n ** 15n;
const SWAP_DEADLINE_SECONDS = 600n;
const PORTFOLIO_CACHE_MS = 60_000;
/** Statuses in which an index vault holds its basket. */
const HOLDING_STATUSES = [
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
  VaultStatus.terminating,
];
const MAX_AUTO_ATTEMPTS = 3;
const AUTO_RETRY_BACKOFF_MS = 10 * 60_000;
const STALE_EXECUTING_MS = 30 * 60_000;

export interface BasketItemInput {
  assetAddress: string;
  weightBps: number;
  symbol?: string;
  name?: string;
  image?: string | null;
}

export interface IndexSupportedAsset {
  assetAddress: string;
  symbol: string;
  name: string | null;
  decimals: number;
  image: string | null;
  /**
   * Whether a new vault could buy this token with ETH and sell it back right
   * now, checked with the same routing as execution. A basket needs both.
   */
  routing?: AssetRouteCheck;
}

export interface IndexSupportedAssets {
  /** When true, baskets may only hold `assets`; otherwise any adapter-quotable ERC-20 is accepted. */
  restricted: boolean;
  assets: IndexSupportedAsset[];
  /** Auto-rebalance bounds the create form and re-weight form apply. */
  rebalance: { minCadenceDays: number; defaultCadenceDays: number };
}

export interface IndexPortfolioAsset {
  assetAddress: string;
  symbol: string;
  name: string | null;
  image: string | null;
  decimals: number;
  inBasket: boolean;
  weightBps: number;
  targetBps: number;
  actualBps: number;
  driftBps: number;
  balance: string;
  valueNative: string;
  valueUsd: number;
  valueAda: number;
}

/** A native amount priced in every display currency. */
export interface IndexValue {
  valueNative: string;
  valueUsd: number;
  valueAda: number;
}

export interface IndexPortfolio {
  /** Basket + cash; the allocation (target/actual bps) is measured against this. */
  navNative: string;
  reserve: { targetBps: number; actualBps: number } & IndexValue;
  assets: IndexPortfolioAsset[];
  /** The vault's LP position (vault token / native), outside the basket allocation. */
  lp: ({ token: string } & IndexValue) | null;
  /** Everything the vault holds: basket + cash + LP. This is the vault's TVL. */
  total: IndexValue;
  pricedAt: string;
  /** Set when the portfolio could not be read; the basket itself is still returned. */
  error?: string;
}

@Injectable()
export class IndexVaultService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IndexVaultService.name);
  private readonly portfolioCache = new Map<string, { at: number; data: IndexPortfolio }>();
  private readonly running = new Set<string>();
  /**
   * `INDEX_BASKET_ALLOWED_ASSETS`: comma-separated token addresses. When set
   * (testnet — the fixed-rate adapter's seeded tokens), baskets are limited to
   * them; unset means any token the adapter can quote.
   */
  private readonly allowedAssets: Address[];
  private supportedAssetsCache: Promise<IndexSupportedAsset[]> | null = null;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(EvmIndexRebalance)
    private readonly rebalanceRepository: Repository<EvmIndexRebalance>,
    private readonly contractReader: EvmContractReader,
    private readonly swapService: EvmSwapService,
    private readonly routeService: IndexSwapRouteService,
    private readonly liquidityService: EvmLiquidityService,
    private readonly priceService: PriceService,
    private readonly systemSettings: SystemSettingsService,
    configService: ConfigService
  ) {
    this.allowedAssets = (configService.get<string>('INDEX_BASKET_ALLOWED_ASSETS') ?? '')
      .split(',')
      .map(a => a.trim().toLowerCase())
      .filter(a => isAddress(a)) as Address[];
  }

  // ---------------------------------------------------------------------------
  // Basket definition
  // ---------------------------------------------------------------------------

  /** Tokens a basket may hold, read from chain once and cached for the process lifetime. */
  async getSupportedAssets(): Promise<IndexSupportedAssets> {
    const rebalance = {
      minCadenceDays: this.systemSettings.indexRebalanceMinCadenceDays,
      defaultCadenceDays: this.systemSettings.indexRebalanceDefaultCadenceDays,
    };
    if (!this.allowedAssets.length) return { restricted: false, assets: [], rebalance };
    this.supportedAssetsCache ??= Promise.all(
      this.allowedAssets.map(async address => {
        const read = (functionName: 'decimals' | 'symbol' | 'name'): Promise<unknown> =>
          this.contractReader.publicClient.readContract({
            address,
            abi: ERC20_METADATA_ABI,
            functionName,
          });
        const [decimals, symbol, name] = await Promise.all([read('decimals'), read('symbol'), read('name')]);
        return {
          assetAddress: address,
          symbol: String(symbol),
          name: String(name),
          decimals: Number(decimals),
          image: null,
        };
      })
    ).catch(err => {
      this.supportedAssetsCache = null;
      throw err;
    });
    const assets = await this.supportedAssetsCache;
    const routing = await Promise.all(assets.map(a => this.routeService.checkAsset(a.assetAddress as Address)));
    return {
      restricted: true,
      assets: assets.map((a, i) => ({ ...a, routing: routing[i] })),
      rebalance,
    };
  }

  /**
   * Route check for one token (buy with ETH, sell back to ETH), for tokens a
   * user adds by address and for re-checking a token in a vault's basket.
   */
  async checkAssetRoutes(assetAddress: string, vaultId?: string): Promise<AssetRouteCheck> {
    const address = assetAddress?.toLowerCase();
    if (!address || !isAddress(address) || address === NATIVE) {
      throw new BadRequestException(`Invalid token address: ${assetAddress}`);
    }
    if (vaultId && !isUUID(vaultId)) throw new BadRequestException(`Invalid vault id: ${vaultId}`);
    const vault = vaultId ? await this.requireIndexVault(vaultId) : null;
    return this.routeService.checkAsset(address as Address, vault);
  }

  /**
   * Reject a market-swap proposal whose token trades Uniswap cannot route for
   * this vault right now, using the same routing as execution. NFT sales and
   * position closes are not swaps and are left to their own checks.
   */
  async assertMarketSwapsRoutable(
    vault: Pick<Vault, 'id' | 'chain_id' | 'evm_protocol_version'>,
    actions: Array<Record<string, any>>
  ): Promise<void> {
    const swaps = actions.filter(a => {
      if (a?.exec === 'CLOSE_POSITION') return false;
      const isSell = a?.exec === MarketplaceAction.SELL || a?.action === MarketplaceAction.SELL;
      const kind = Number(a?.assetKind ?? a?.kind);
      return !(isSell && (kind === EvmAssetKind.ERC721 || kind === EvmAssetKind.ERC1155));
    });
    if (!swaps.length) return;

    let adapter: Address;
    try {
      adapter = this.routeService.tradingAdapterFor(vault);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    for (const a of swaps) {
      const assetIn = (a.inputAsset ?? a.policyId ?? NATIVE) as Address;
      const assetOut = (a.expectedOutputAsset ?? a.outputAsset ?? NATIVE) as Address;
      const amountIn = BigInt(a.amount ?? a.quantity ?? 0);
      if (amountIn === 0n || assetIn.toLowerCase() === assetOut.toLowerCase()) continue;
      try {
        await this.routeService.quote(assetIn, assetOut, amountIn, adapter);
      } catch (err) {
        if (err instanceof NoSupportedRouteError) {
          throw new BadRequestException(`Uniswap cannot route this trade right now (${err.reason}).`);
        }
        throw new BadRequestException(
          'Could not check the trade route: Uniswap did not answer. Please try again shortly.'
        );
      }
    }
  }

  /** Keeps the token picker's route checks warm so the asset list answers from cache. */
  onApplicationBootstrap(): void {
    // Warm the token picker's route checks in the background; never block startup on Uniswap.
    void this.refreshAssetRouteChecks();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshAssetRouteChecks(): Promise<void> {
    if (!this.allowedAssets.length || !this.routeService.adapter) return;
    for (const asset of this.allowedAssets) {
      await this.routeService.checkAsset(asset, null, true).catch(err => {
        this.logger.warn(`Route check for ${asset} failed: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Validate a basket and resolve each asset's decimals from chain. Symbol and
   * name come from chain too when the caller did not supply them.
   *
   * Every asset must be quotable from native through the configured swap
   * adapter — a basket the vault cannot buy would lock contributors' ETH in a
   * vault that never becomes an index.
   */
  async resolveBasket(items: BasketItemInput[], vault: VaultRouteRef = null): Promise<IndexTarget[]> {
    const error = validateWeights({
      weightsBps: items.map(i => Number(i.weightBps)),
      maxAssets: INDEX_MAX_ASSETS,
      minWeightBps: INDEX_MIN_WEIGHT_BPS,
    });
    if (error) throw new BadRequestException(error);

    const seen = new Set<string>();
    for (const item of items) {
      const address = item.assetAddress?.toLowerCase();
      if (!address || !isAddress(address) || address === NATIVE) {
        throw new BadRequestException(`Invalid basket asset address: ${item.assetAddress}`);
      }
      if (seen.has(address)) throw new BadRequestException(`Asset ${address} appears twice in the basket`);
      seen.add(address);
      if (this.allowedAssets.length && !this.allowedAssets.includes(address as Address)) {
        throw new BadRequestException(`${item.symbol || address} is not a supported index basket asset`);
      }
    }

    if (!this.routeService.adapter) {
      throw new BadRequestException('Index vaults are not enabled: no swap adapter is configured');
    }
    try {
      this.routeService.tradingAdapterFor(vault);
    } catch (err) {
      if (err instanceof SwapAdapterOutdatedError) throw new BadRequestException(err.message);
      throw err;
    }

    return Promise.all(
      items.map(async item => {
        const address = item.assetAddress.toLowerCase() as Address;
        let decimals: number;
        try {
          decimals = Number(
            await this.contractReader.publicClient.readContract({
              address,
              abi: ERC20_METADATA_ABI,
              functionName: 'decimals',
            })
          );
        } catch {
          throw new BadRequestException(`${address} is not an ERC-20 token on this chain`);
        }

        const symbol =
          item.symbol ||
          ((await this.contractReader.publicClient
            .readContract({
              address,
              abi: ERC20_METADATA_ABI,
              functionName: 'symbol',
            })
            .catch(() => null)) as string | null) ||
          address.slice(0, 8);
        const name =
          item.name ||
          ((await this.contractReader.publicClient
            .readContract({
              address,
              abi: ERC20_METADATA_ABI,
              functionName: 'name',
            })
            .catch(() => null)) as string | null);

        // Both directions, with the routing execution uses: a token the vault
        // can buy but never sell could not be rebalanced or wound down.
        assertTradable(symbol, await this.routeService.checkAsset(address, vault, true));

        return {
          assetAddress: address,
          symbol,
          name,
          decimals,
          image: item.image ?? null,
          weightBps: Number(item.weightBps),
        };
      })
    );
  }

  buildConfig(
    targets: IndexTarget[],
    reserveBps: number,
    previous?: IndexConfig | null,
    proposalId?: string,
    schedule?: IndexScheduleInput
  ): IndexConfig {
    if (!Number.isInteger(reserveBps) || reserveBps < 0 || reserveBps > 5000) {
      throw new BadRequestException('The cash reserve must be between 0% and 50%');
    }
    const resolved = this.resolveSchedule(schedule, previous);
    const { autoRebalance, rebalanceCadenceDays } = resolved;
    const nextRebalanceAt = nextRunAfterConfigChange(resolved, previous, c => this.computeNextRebalanceAt(c));
    return {
      targets,
      reserveBps,
      driftToleranceBps: previous?.driftToleranceBps ?? INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
      slippageBps: previous?.slippageBps ?? INDEX_DEFAULT_SLIPPAGE_BPS,
      version: (previous?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedByProposalId: proposalId ?? null,
      autoRebalance,
      rebalanceCadenceDays,
      nextRebalanceAt,
    };
  }

  /** Auto-rebalance fields with the admin limits applied; see index-rebalance.schedule. */
  resolveSchedule(input: IndexScheduleInput | undefined, previous?: IndexConfig | null): ResolvedSchedule {
    const result = resolveSchedule(input, previous, {
      minCadenceDays: this.systemSettings.indexRebalanceMinCadenceDays,
      defaultCadenceDays: this.systemSettings.indexRebalanceDefaultCadenceDays,
    });
    if ('error' in result) throw new BadRequestException(result.error);
    return result;
  }

  computeNextRebalanceAt(cadenceDays: number | null, from = Date.now()): string | null {
    return computeNextRebalanceAt(cadenceDays, this.systemSettings.indexRebalanceJitterHours, from);
  }

  // ---------------------------------------------------------------------------
  // Read side
  // ---------------------------------------------------------------------------

  async getOverview(vaultId: string): Promise<{
    vaultArchetype: VaultArchetype;
    config: IndexConfig | null;
    portfolio: IndexPortfolio | null;
    rebalances: ReturnType<IndexVaultService['serializeRebalance']>[];
  }> {
    const vault = await this.requireIndexVault(vaultId);
    const hasHoldings = !!vault.contract_address && HOLDING_STATUSES.includes(vault.vault_status);

    const [portfolio, rebalances] = await Promise.all([
      hasHoldings ? this.getPortfolio(vault) : Promise.resolve(null),
      this.rebalanceRepository.find({
        where: { vault_id: vaultId },
        order: { created_at: 'DESC' },
        take: 10,
      }),
    ]);

    return {
      vaultArchetype: vault.vault_archetype,
      config: vault.index_config ?? null,
      portfolio,
      rebalances: rebalances.map(r => this.serializeRebalance(r)),
    };
  }

  /**
   * Dry-run a re-weight against the live portfolio. The buy side assumes every
   * sell fills at its quote, so it is an estimate, not an execution plan.
   */
  async previewReweight(
    vaultId: string,
    items: BasketItemInput[],
    reserveBps: number
  ): Promise<{
    sells: {
      asset: string;
      amountIn: string;
      valueNative: string;
      exit: boolean;
    }[];
    buys: { asset: string; nativeIn: string }[];
    /** Needed legs that were not planned, with why — so an empty plan is never mistaken for "on target". */
    skipped: {
      asset: string;
      side: 'sell' | 'buy';
      reason: IndexRebalanceSkipReason;
      valueNative: string;
      detail?: string;
    }[];
    minTradeNative: string;
    navNative: string;
  }> {
    const vault = await this.requireIndexVault(vaultId);
    if (!vault.contract_address) throw new BadRequestException('Vault is not deployed yet');

    // Resolved exactly as a re-weight proposal would resolve it, so a basket
    // that previews cleanly is a basket that can actually be submitted.
    const resolved = await this.resolveBasket(items, vault);
    const targets: WeightTarget[] = resolved.map(t => ({
      asset: t.assetAddress,
      weightBps: t.weightBps,
    }));
    const opts = this.planOptions(vault.index_config, reserveBps);
    const state = await this.readState(
      vault,
      targets.map(t => t.asset as Address)
    );

    const skipped: SkippedLeg[] = [];
    const sells = planSells(state, targets, opts, skipped);
    const afterSells: PortfolioState = {
      nativeAvailable: state.nativeAvailable + sells.reduce((s, x) => s + x.valueNative, 0n),
      holdings: state.holdings.map(h => {
        const sold = sells.find(s => s.asset === h.asset);
        if (!sold) return h;
        return {
          asset: h.asset,
          balance: h.balance - sold.amountIn,
          valueNative: h.valueNative - sold.valueNative,
        };
      }),
    };
    const plannedBuys = planBuys(afterSells, targets, opts, skipped);

    // Route every planned trade at its real size, as execution will. A trade
    // Uniswap cannot route is reported, never shown as if it will happen.
    const adapter = this.routeService.tradingAdapterFor(vault);
    const routable = async (assetIn: Address, assetOut: Address, amountIn: bigint): Promise<string | null> => {
      try {
        await this.routeService.quote(assetIn, assetOut, amountIn, adapter);
        return null;
      } catch (err) {
        if (err instanceof NoSupportedRouteError) return err.reason;
        throw err;
      }
    };
    const sellsRouted = await Promise.all(sells.map(s => routable(s.asset as Address, NATIVE, s.amountIn)));
    const buysRouted = await Promise.all(plannedBuys.map(b => routable(NATIVE, b.asset as Address, b.nativeIn)));
    sells.forEach((s, i) => {
      const detail = sellsRouted[i];
      if (detail)
        skipped.push({ asset: s.asset, side: 'sell', reason: 'no_route', valueNative: s.valueNative, detail });
    });
    plannedBuys.forEach((b, i) => {
      const detail = buysRouted[i];
      if (detail) skipped.push({ asset: b.asset, side: 'buy', reason: 'no_route', valueNative: b.nativeIn, detail });
    });
    const routedSells = sells.filter((_, i) => !sellsRouted[i]);
    const buys = plannedBuys.filter((_, i) => !buysRouted[i]);

    return {
      skipped: skipped.map(s => ({
        ...s,
        valueNative: s.valueNative.toString(),
      })),
      minTradeNative: opts.minTradeNative.toString(),
      navNative: computeNav(state).toString(),
      sells: routedSells.map(s => ({
        asset: s.asset,
        amountIn: s.amountIn.toString(),
        valueNative: s.valueNative.toString(),
        exit: s.exit,
      })),
      buys: buys.map(b => ({
        asset: b.asset,
        nativeIn: b.nativeIn.toString(),
      })),
    };
  }

  /**
   * Reject a re-weight that would trade nothing because the legs it needs are blocked (below the
   * minimum trade, or no native above the reserve). Such a proposal would only overwrite the stored
   * weights, and no automatic rebalance trades to them later. "Within tolerance" stays allowed.
   * If the live portfolio cannot be read, the proposal is not blocked (logged): an RPC outage must
   * not stop governance.
   */
  async assertReweightTrades(vaultId: string, items: BasketItemInput[], reserveBps: number): Promise<void> {
    let preview: Awaited<ReturnType<IndexVaultService['previewReweight']>>;
    try {
      preview = await this.previewReweight(vaultId, items, reserveBps);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`Re-weight trade check skipped for vault ${vaultId}: ${(err as Error).message}`);
      return;
    }

    // A re-weight that needs a trade Uniswap cannot route would pass the vote
    // and then stall; refuse it while the proposer can still change the basket.
    const unroutable = preview.skipped.filter(s => s.reason === 'no_route');
    if (unroutable.length) {
      const symbolOf = (a: string): string =>
        items.find(t => t.assetAddress?.toLowerCase() === a.toLowerCase())?.symbol || `${a.slice(0, 8)}…`;
      const list = unroutable
        .map(s => `${symbolOf(s.asset)} (${s.side === 'buy' ? 'buy' : 'sell'}: ${s.detail ?? 'no route'})`)
        .join('; ');
      throw new BadRequestException(
        `This re-weight needs trades Uniswap cannot route right now: ${list}. Adjust the basket and try again.`
      );
    }

    if (preview.sells.length || preview.buys.length) return;

    const blocking = preview.skipped.filter(s => s.reason !== 'within_tolerance');
    if (blocking.length === 0) return;

    const eth = (wei: string) => Number(formatUnits(BigInt(wei), 18)).toPrecision(2);
    if (blocking.every(s => s.reason === 'below_min_trade')) {
      throw new BadRequestException(
        `The vault is too small to trade: each trade must be at least ${eth(preview.minTradeNative)} ETH ` +
          `(vault value ≈ ${eth(preview.navNative)} ETH), so this re-weight would not make any trade.`
      );
    }
    throw new BadRequestException(
      'This re-weight would not make any trade: the vault has no ETH above its cash reserve to buy with.'
    );
  }

  private async getPortfolio(vault: Vault): Promise<IndexPortfolio> {
    const cached = this.portfolioCache.get(vault.id);
    if (cached && Date.now() - cached.at < PORTFOLIO_CACHE_MS) return cached.data;

    const config = vault.index_config;
    const targets = config?.targets ?? [];
    const reserveBps = config?.reserveBps ?? 0;

    try {
      const [state, lp, prices] = await Promise.all([
        this.readState(
          vault,
          targets.map(t => t.assetAddress as Address)
        ),
        this.liquidityService.getVaultLp(vault.id),
        this.displayPrices(),
      ]);
      const allocation = computeAllocation(
        state,
        targets.map(t => ({ asset: t.assetAddress, weightBps: t.weightBps })),
        reserveBps
      );
      const byAddress = new Map(targets.map(t => [t.assetAddress, t]));
      const balances = new Map(state.holdings.map(h => [h.asset, h.balance]));

      const lpValue = lp?.lpToken && lp.vaultValueNative ? BigInt(lp.vaultValueNative) : 0n;

      const data: IndexPortfolio = {
        navNative: allocation.nav.toString(),
        reserve: {
          targetBps: reserveBps,
          actualBps: allocation.reserveActualBps,
          ...this.priced(state.nativeAvailable, prices),
        },
        assets: allocation.rows.map(row => {
          const target = byAddress.get(row.asset);
          return {
            assetAddress: row.asset,
            symbol: target?.symbol ?? row.asset.slice(0, 8),
            name: target?.name ?? null,
            image: target?.image ?? null,
            decimals: target?.decimals ?? 18,
            inBasket: !!target,
            weightBps: target?.weightBps ?? 0,
            targetBps: row.targetBps,
            actualBps: row.actualBps,
            driftBps: row.driftBps,
            balance: (balances.get(row.asset) ?? 0n).toString(),
            ...this.priced(row.valueNative, prices),
          };
        }),
        lp: lpValue > 0n ? { token: lp.lpToken, ...this.priced(lpValue, prices) } : null,
        total: this.priced(allocation.nav + lpValue, prices),
        pricedAt: new Date().toISOString(),
      };
      this.portfolioCache.set(vault.id, { at: Date.now(), data });
      return data;
    } catch (err) {
      this.logger.warn(`Index portfolio read failed for vault ${vault.id}: ${(err as Error).message}`);
      return {
        navNative: '0',
        reserve: {
          targetBps: reserveBps,
          actualBps: 0,
          valueNative: '0',
          valueUsd: 0,
          valueAda: 0,
        },
        assets: [],
        lp: null,
        total: { valueNative: '0', valueUsd: 0, valueAda: 0 },
        pricedAt: new Date().toISOString(),
        error: 'Live holdings are temporarily unavailable',
      };
    }
  }

  /**
   * Free native plus every ERC-20 the vault could hold a basket position in:
   * the targets and anything already in custody. The vault's own token and its
   * LP receipt are never holdings (the receipt cannot be sold; the portfolio
   * values it separately). A basket asset that cannot be priced aborts — trading
   * on a guessed value would mis-size every other leg.
   */
  private async readState(
    vault: Pick<Vault, 'id' | 'contract_address'>,
    basketAssets: Address[]
  ): Promise<PortfolioState> {
    const client = this.contractReader.publicClient;
    const vaultAddress = vault.contract_address as Address;
    const lpToken = (await this.liquidityService.getVaultLp(vault.id))?.lpToken?.toLowerCase();
    const [nativeAvailable, custody, vaultToken] = (await Promise.all([
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableNativeForOperations',
      }),
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'custodyTokens',
      }),
      client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'vaultToken',
      }),
    ])) as [bigint, Address[], Address];

    const basket = new Set(basketAssets.map(a => a.toLowerCase()));
    const tokens = [...new Set([...basket, ...custody.map(a => a.toLowerCase())])].filter(
      t => t !== vaultToken.toLowerCase() && t !== lpToken
    ) as Address[];

    const holdings: HoldingValue[] = [];
    for (const token of tokens) {
      const balance = (await client.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'availableErc20ForOperations',
        args: [token],
      })) as bigint;
      if (balance === 0n) {
        if (basket.has(token)) holdings.push({ asset: token, balance, valueNative: 0n });
        continue;
      }
      try {
        holdings.push({
          asset: token,
          balance,
          valueNative: await this.routeService.valueInNative(token, balance),
        });
      } catch (err) {
        if (basket.has(token)) {
          throw new Error(`Cannot price basket asset ${token}: ${(err as Error).message}`);
        }
        this.logger.warn(`Ignoring unpriceable custody token ${token} in ${vaultAddress}: ${(err as Error).message}`);
      }
    }

    return { nativeAvailable, holdings };
  }

  private async displayPrices(): Promise<{ ethUsd: number; adaUsd: number }> {
    const [ethUsd, adaUsd] = await Promise.all([this.priceService.getEthPrice(), this.priceService.getAdaPrice()]);
    return { ethUsd, adaUsd };
  }

  private priced(wei: bigint, prices: { ethUsd: number; adaUsd: number }): IndexValue {
    const valueUsd = Number(formatUnits(wei, 18)) * prices.ethUsd;
    return {
      valueNative: wei.toString(),
      valueUsd,
      valueAda: prices.adaUsd > 0 ? valueUsd / prices.adaUsd : 0,
    };
  }

  // ---------------------------------------------------------------------------
  // TVL
  // ---------------------------------------------------------------------------

  /**
   * Index vaults hold what they bought on-chain, not the `assets` rows the
   * generic valuation sums, so their TVL columns are written from the live
   * portfolio here (TaptoolsService skips them).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncVaultTotals(): Promise<void> {
    const vaults = await this.vaultRepository.find({
      where: {
        vault_archetype: VaultArchetype.index_weighted,
        chain_type: ChainType.robinhood,
        vault_status: In(HOLDING_STATUSES),
        contract_address: Not(IsNull()),
        deleted: false,
      },
    });

    for (const vault of vaults) {
      const portfolio = await this.getPortfolio(vault);
      if (portfolio.error) continue;
      const { total } = portfolio;
      const updates: Partial<Vault> = {
        total_assets_cost_eth: Number(formatUnits(BigInt(total.valueNative), 18)),
        total_assets_cost_usd: total.valueUsd,
        total_assets_cost_ada: total.valueAda,
        last_valuation_update: new Date(),
      };
      if (vault.vault_status === VaultStatus.locked && vault.fdv && total.valueAda > 0.0001) {
        updates.fdv_tvl = Number((vault.fdv / total.valueAda).toFixed(2));
      }
      await this.vaultRepository.update({ id: vault.id }, updates);
    }
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /**
   * Cron entry point: buy the basket for every index vault whose latest cycle
   * locked and has not been invested yet. Also covers acquire-expansion cycles,
   * since the idempotency key is per cycle.
   */
  async runPendingInitialBuys(): Promise<void> {
    const vaults = await this.vaultRepository.find({
      where: {
        chain_type: ChainType.robinhood,
        vault_archetype: VaultArchetype.index_weighted,
        vault_status: VaultStatus.locked,
        contract_address: Not(IsNull()),
        evm_root_committed_at: Not(IsNull()),
      },
      select: ['id', 'evm_current_cycle_id'],
    });

    for (const vault of vaults) {
      if (!vault.evm_current_cycle_id) continue;
      // The pool gets its native first; buying the basket now would spend it.
      if (await this.liquidityService.isLpPending(vault.id, vault.evm_current_cycle_id)) continue;
      const key = `initial:cycle:${vault.evm_current_cycle_id}`;
      const existing = await this.rebalanceRepository.findOne({
        where: { vault_id: vault.id, idempotency_key: key },
      });
      if (existing?.status === IndexRebalanceStatus.completed) continue;
      if (existing?.status === IndexRebalanceStatus.failed) {
        const cooledDown = Date.now() - existing.updated_at.getTime() > AUTO_RETRY_BACKOFF_MS;
        if (existing.attempts >= MAX_AUTO_ATTEMPTS || !cooledDown) continue;
      }

      try {
        await this.runRebalance(vault.id, IndexRebalanceTrigger.initial_buy, key);
      } catch (err) {
        this.logger.error(`Index initial buy failed for vault ${vault.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Cron entry point for auto-rebalancing: trade every opted-in index vault back
   * to its target weights once its cadence (plus random jitter) has elapsed.
   *
   * At most one run per period: the idempotency key carries the scheduled time,
   * and the next time is set before trading, so a crash mid-run cannot cause a
   * second run in the same period. A run inside drift tolerance makes no trades
   * and simply completes.
   */
  async runScheduledRebalances(): Promise<void> {
    const vaults = await this.vaultRepository
      .createQueryBuilder('v')
      .select(['v.id', 'v.evm_current_cycle_id', 'v.index_config'])
      .where('v.chain_type = :chain', { chain: ChainType.robinhood })
      .andWhere('v.vault_archetype = :arch', {
        arch: VaultArchetype.index_weighted,
      })
      .andWhere('v.vault_status = :status', { status: VaultStatus.locked })
      .andWhere('v.contract_address IS NOT NULL')
      .andWhere('v.deleted = false')
      .andWhere(`(v.index_config->>'autoRebalance')::boolean = true`)
      .getMany();

    const now = Date.now();
    for (const vault of vaults) {
      const config = vault.index_config;
      if (!config?.autoRebalance || !vault.evm_current_cycle_id) continue;

      // Never trade before the basket exists or while the pool waits for its native.
      const initial = await this.rebalanceRepository.findOne({
        where: {
          vault_id: vault.id,
          idempotency_key: `initial:cycle:${vault.evm_current_cycle_id}`,
        },
      });
      if (initial?.status !== IndexRebalanceStatus.completed) continue;
      if (await this.liquidityService.isLpPending(vault.id, vault.evm_current_cycle_id)) continue;

      // First time (or re-enabled): start the clock from now, trade next period.
      if (!config.nextRebalanceAt) {
        await this.setNextRebalanceAt(vault.id, this.computeNextRebalanceAt(config.rebalanceCadenceDays ?? null, now));
        continue;
      }

      const dueAt = new Date(config.nextRebalanceAt).getTime();
      const key = `scheduled:${config.nextRebalanceAt}`;
      const existing = await this.rebalanceRepository.findOne({
        where: { vault_id: vault.id, idempotency_key: key },
      });
      if (existing || dueAt > now) continue;

      // Move the clock first: whatever happens to this run, the next one is a new period.
      // A failed run is not retried automatically; the next period trades the drift anyway,
      // and an operator can still retry it from the admin endpoint.
      await this.setNextRebalanceAt(vault.id, this.computeNextRebalanceAt(config.rebalanceCadenceDays ?? null, now));
      try {
        await this.runRebalance(vault.id, IndexRebalanceTrigger.scheduled, key);
      } catch (err) {
        this.logger.error(`Index auto-rebalance failed for vault ${vault.id}: ${(err as Error).message}`);
      }
    }
  }

  /** Writes only `nextRebalanceAt` inside the JSONB config, so a concurrent re-weight is not overwritten. */
  private async setNextRebalanceAt(vaultId: string, at: string | null): Promise<void> {
    await this.vaultRepository
      .createQueryBuilder()
      .update(Vault)
      .set({
        index_config: () => `jsonb_set(index_config, '{nextRebalanceAt}', :next::jsonb)`,
      })
      .setParameter('next', JSON.stringify(at))
      .where('id = :id', { id: vaultId })
      .execute();
  }

  /**
   * Execute a passed INDEX_REWEIGHT proposal: adopt the new basket, then trade
   * to it. Safe to call again after a failure — the config bump is keyed to the
   * proposal and the trades resume from their persisted legs.
   */
  async executeReweightProposal(proposal: Proposal): Promise<boolean> {
    const payload = proposal.metadata?.indexReweight;
    if (!payload?.targets?.length) {
      this.logger.error(`Proposal ${proposal.id}: missing indexReweight metadata`);
      return false;
    }

    const vault = await this.requireIndexVault(proposal.vaultId);
    if (vault.index_config?.updatedByProposalId !== proposal.id) {
      const config = this.buildConfig(payload.targets, payload.reserveBps, vault.index_config, proposal.id, {
        autoRebalance: payload.autoRebalance,
        rebalanceCadenceDays: payload.rebalanceCadenceDays,
      });
      await this.vaultRepository.update({ id: vault.id }, { index_config: config });
      this.portfolioCache.delete(vault.id);
    }

    // A schedule-only proposal changes when the keeper trades, not what it targets.
    if (payload.scheduleOnly) return true;

    try {
      const run = await this.runRebalance(
        vault.id,
        IndexRebalanceTrigger.governance_reweight,
        `proposal:${proposal.id}`,
        proposal.id
      );
      return run.status === IndexRebalanceStatus.completed;
    } catch (err) {
      this.logger.error(`Proposal ${proposal.id}: re-weight trades failed — ${(err as Error).message}`);
      return false;
    }
  }

  /** Operator retry of a failed run, ignoring the automatic attempt cap. */
  async retryRebalance(
    vaultId: string,
    rebalanceId: string
  ): Promise<ReturnType<IndexVaultService['serializeRebalance']>> {
    const run = await this.rebalanceRepository.findOne({
      where: { id: rebalanceId, vault_id: vaultId },
    });
    if (!run) throw new NotFoundException('Rebalance not found');
    if (run.status === IndexRebalanceStatus.completed) return this.serializeRebalance(run);
    const result = await this.runRebalance(vaultId, run.trigger, run.idempotency_key, run.proposal_id ?? undefined);
    return this.serializeRebalance(result);
  }

  async runRebalance(
    vaultId: string,
    trigger: IndexRebalanceTrigger,
    idempotencyKey: string,
    proposalId?: string
  ): Promise<EvmIndexRebalance> {
    const vault = await this.requireIndexVault(vaultId);
    const config = vault.index_config;
    if (!config?.targets?.length) throw new Error(`Vault ${vaultId} has no index basket configured`);
    if (!vault.contract_address) throw new Error(`Vault ${vaultId} has no contract address`);
    const vaultAddress = vault.contract_address as Address;
    const adapter = this.routeService.tradingAdapterFor(vault);

    const lockKey = `${vaultId}`;
    if (this.running.has(lockKey)) throw new Error(`A rebalance is already running for vault ${vaultId}`);
    this.running.add(lockKey);

    try {
      let run = await this.rebalanceRepository.findOne({
        where: { vault_id: vaultId, idempotency_key: idempotencyKey },
      });
      if (!run) {
        run = await this.rebalanceRepository.save(
          this.rebalanceRepository.create({
            vault_id: vaultId,
            idempotency_key: idempotencyKey,
            trigger,
            proposal_id: proposalId ?? null,
            status: IndexRebalanceStatus.pending,
            phase: IndexRebalancePhase.sells,
            targets: config.targets,
            reserve_bps: config.reserveBps,
            legs: [],
            skipped_legs: [],
          })
        );
      }
      if (run.status === IndexRebalanceStatus.completed) return run;

      // Runs of one vault must never interleave: each plans from the live
      // portfolio, so two concurrent runs would size trades against balances
      // the other is changing. The in-process lock above only covers this
      // replica, so the claim below is made under a vault-wide database lock.
      if (!(await this.claimRebalanceSlot(run, vaultId))) return run;
      run.status = IndexRebalanceStatus.executing;
      run.attempts += 1;

      try {
        // Vaults from factories older than V8 have no `swap`; fail with the cause
        // rather than a revert from the first view the planner happens to call.
        await this.swapService.isOperationIdUsed(vaultAddress, `0x${'00'.repeat(32)}`).catch(() => {
          throw new Error(
            `Vault ${vaultAddress} has no Vault.swap — it was deployed by a pre-V8 factory. ` +
              'Index vaults need a vault created through the V8+ VaultFactory.'
          );
        });

        const targets = run.targets.map(t => ({
          asset: t.assetAddress,
          weightBps: t.weightBps,
        }));
        const opts = this.planOptions(config, run.reserve_bps);
        const tradeFeeBps = await this.swapService.tradeFeeBps(vaultAddress);

        for (const phase of [IndexRebalancePhase.sells, IndexRebalancePhase.buys]) {
          if (run.phase !== phase) continue;
          const side = phase === IndexRebalancePhase.sells ? IndexLegSide.sell : IndexLegSide.buy;

          await this.settleStaleLegs(run, side, vaultAddress);

          const state = await this.readState(
            vault,
            targets.map(t => t.asset as Address)
          );
          if (run.nav_native == null) {
            run.nav_native = state.holdings.reduce((s, h) => s + h.valueNative, state.nativeAvailable).toString();
          }

          const skipped: SkippedLeg[] = [];
          const planned =
            side === IndexLegSide.sell
              ? planSells(state, targets, opts, skipped).map(s => ({
                  assetIn: s.asset,
                  assetOut: NATIVE as string,
                  amountIn: s.amountIn,
                }))
              : planBuys(state, targets, opts, skipped).map(b => ({
                  assetIn: NATIVE as string,
                  assetOut: b.asset,
                  amountIn: b.nativeIn,
                }));

          run.skipped_legs = [
            ...(run.skipped_legs ?? []).filter(item => item.side !== side),
            ...skipped.map(item => this.serializePlanningSkip(item, run.targets, opts.minTradeNative)),
          ];
          this.logPlanningSkips(
            run.id,
            vaultId,
            run.skipped_legs.filter(item => item.side === side)
          );

          for (const p of planned) {
            const index = run.legs.length;
            run.legs.push({
              index,
              side,
              operationId: this.operationId(vaultId, idempotencyKey, index),
              assetIn: p.assetIn,
              assetOut: p.assetOut,
              amountIn: p.amountIn.toString(),
              status: IndexLegStatus.pending,
            });
          }
          await this.rebalanceRepository.update(
            { id: run.id },
            {
              legs: run.legs,
              skipped_legs: run.skipped_legs,
              nav_native: run.nav_native,
            }
          );

          for (const leg of run.legs.filter(l => l.side === side && l.status === IndexLegStatus.pending)) {
            await this.executeLeg(run, leg, vaultId, vaultAddress, adapter, config.slippageBps, tradeFeeBps);
          }

          run.phase = side === IndexLegSide.sell ? IndexRebalancePhase.buys : IndexRebalancePhase.done;
          await this.rebalanceRepository.update({ id: run.id }, { phase: run.phase });
        }

        run.status = IndexRebalanceStatus.completed;
        run.completed_at = new Date();
        await this.rebalanceRepository.update(
          { id: run.id },
          {
            status: run.status,
            completed_at: run.completed_at,
            legs: run.legs,
            skipped_legs: run.skipped_legs,
          }
        );
        this.logger.log(
          `Index rebalance ${run.id} (${idempotencyKey}) completed for vault ${vaultId}: ` +
            `${run.legs.filter(l => l.status === IndexLegStatus.confirmed).length} leg(s) traded, ` +
            `${run.skipped_legs.filter(l => l.reason !== 'within_tolerance').length} blocked adjustment(s)`
        );
        return run;
      } catch (err) {
        run.status = IndexRebalanceStatus.failed;
        run.last_error = (err as Error).message.slice(0, 1000);
        await this.rebalanceRepository.update(
          { id: run.id },
          { status: run.status, last_error: run.last_error, legs: run.legs }
        );
        throw err;
      }
    } finally {
      this.running.delete(lockKey);
      this.portfolioCache.delete(vaultId);
    }
  }

  /**
   * Move this run into `executing`, or refuse because the vault is busy.
   *
   * The whole decision — expire abandoned runs, look for a live one, take the
   * slot — happens inside one transaction that holds a write lock on the vault
   * row, so two replicas planning different runs of the same vault (an initial
   * buy and a governance re-weight, say) can never both pass the check. A run
   * left `executing` by a crashed worker no longer owns the vault once its
   * stale window has passed; its legs are settled against chain by
   * {@link settleStaleLegs} before anything re-trades.
   *
   * @returns false when the run is already finished or another worker took it.
   */
  private async claimRebalanceSlot(run: EvmIndexRebalance, vaultId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - STALE_EXECUTING_MS);
    const queryRunner = this.rebalanceRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager
        .createQueryBuilder(Vault, 'v')
        .setLock('pessimistic_write')
        .where('v.id = :vaultId', { vaultId })
        .getOne();

      await queryRunner.manager
        .createQueryBuilder()
        .update(EvmIndexRebalance)
        .set({
          status: IndexRebalanceStatus.failed,
          last_error: 'abandoned: worker stopped mid-run',
        })
        .where('vault_id = :vaultId AND status = :executing AND updated_at < :staleBefore', {
          vaultId,
          executing: IndexRebalanceStatus.executing,
          staleBefore,
        })
        .execute();

      const live = await queryRunner.manager
        .createQueryBuilder(EvmIndexRebalance, 'r')
        .where('r.vault_id = :vaultId AND r.id <> :id AND r.status = :executing', {
          vaultId,
          id: run.id,
          executing: IndexRebalanceStatus.executing,
        })
        .getCount();
      if (live > 0) {
        await queryRunner.commitTransaction();
        throw new Error(`Another rebalance is executing for vault ${vaultId}; retry later`);
      }

      const claimed = await queryRunner.manager
        .createQueryBuilder()
        .update(EvmIndexRebalance)
        .set({
          status: IndexRebalanceStatus.executing,
          attempts: () => '"attempts" + 1',
          last_error: null,
        })
        .where('id = :id AND status IN (:...open)', {
          id: run.id,
          open: [IndexRebalanceStatus.pending, IndexRebalanceStatus.failed],
        })
        .execute();

      await queryRunner.commitTransaction();
      return (claimed.affected ?? 0) > 0;
    } catch (err) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Before re-planning a phase, resolve legs left over from a previous attempt.
   * A leg the vault already consumed landed (receipt lost) and is adopted; an
   * unconsumed leg past its deadline can no longer trade and is superseded by
   * the fresh plan.
   */
  private async settleStaleLegs(run: EvmIndexRebalance, side: IndexLegSide, vaultAddress: Address): Promise<void> {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    for (const leg of run.legs) {
      if (leg.side !== side || leg.status === IndexLegStatus.confirmed || leg.status === IndexLegStatus.skipped) {
        continue;
      }
      if (await this.swapService.isOperationIdUsed(vaultAddress, leg.operationId as Hex)) {
        leg.status = IndexLegStatus.confirmed;
        leg.error = 'adopted: operation id already consumed on-chain';
        continue;
      }
      // A leg that was broadcast may still be in the mempool. Replacing it
      // before its deadline could fill both; after the deadline the vault
      // rejects the old transaction, so re-planning is safe. A leg known never
      // to have been sent (`broadcast === false`) has nothing to wait for.
      if (leg.broadcast !== false && leg.deadline && BigInt(leg.deadline) >= nowSec) {
        await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
        throw new Error(`Leg ${leg.index} may still land until ${leg.deadline}; retry after its deadline`);
      }
      leg.status = IndexLegStatus.skipped;
      leg.error = leg.error ? `superseded after: ${leg.error}` : 'superseded by re-plan';
    }
    await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
  }

  private async executeLeg(
    run: EvmIndexRebalance,
    leg: IndexRebalanceLeg,
    vaultId: string,
    vaultAddress: Address,
    adapter: Address,
    slippageBps: number,
    tradeFeeBps: number
  ): Promise<void> {
    const amountIn = BigInt(leg.amountIn);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;

    // Route, then price that exact route by simulating Vault.swap; the floor
    // comes from the simulation. Nothing is sent if either step fails.
    let prepared: Awaited<ReturnType<IndexSwapRouteService['prepareSwap']>>;
    try {
      prepared = await this.routeService.prepareSwap({
        vaultAddress,
        adapter,
        operationId: leg.operationId as Hex,
        assetIn: leg.assetIn as Address,
        assetOut: leg.assetOut as Address,
        amountIn,
        deadline,
        slippageBps,
        tradeFeeBps,
      });
    } catch (err) {
      leg.broadcast = false;
      leg.deadline = null;
      leg.error = (err as Error).message.slice(0, 500);
      if (err instanceof NoSupportedRouteError) {
        // Not tradable right now: skip this leg and keep trading the others.
        leg.status = IndexLegStatus.skipped;
        const asset = leg.side === IndexLegSide.sell ? leg.assetIn : leg.assetOut;
        const target = run.targets.find(t => t.assetAddress.toLowerCase() === asset.toLowerCase());
        run.skipped_legs = [
          ...(run.skipped_legs ?? []),
          {
            asset: asset.toLowerCase(),
            symbol: target?.symbol ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`,
            side: leg.side,
            reason: 'no_route',
            valueNative: leg.side === IndexLegSide.buy ? leg.amountIn : (leg.quotedOut ?? '0'),
            minTradeNative: MIN_TRADE_NATIVE.toString(),
            detail: err.reason,
          },
        ];
        this.logger.warn(`Index rebalance ${run.id}: leg ${leg.index} skipped — ${err.message}`);
        await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs, skipped_legs: run.skipped_legs });
        return;
      }
      leg.status = IndexLegStatus.failed;
      await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
      throw err;
    }

    const { params, quote } = prepared;
    leg.quotedOut = quote.amountOut.toString();
    leg.minAmountOut = params.minAmountOut.toString();
    leg.route = quote.plan ? await this.routeService.describe(quote.plan).catch(() => null) : null;
    leg.deadline = deadline.toString();
    leg.broadcast = null;
    await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });

    try {
      const result = await this.swapService.swap(vaultId, params, {
        onBroadcast: async hash => {
          leg.broadcast = true;
          leg.txHash = hash;
          await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
        },
      });
      leg.status = IndexLegStatus.confirmed;
      leg.broadcast = true;
      leg.txHash = result.txHash;
      leg.grossOut = result.grossOut.toString();
      leg.fee = result.fee.toString();
      leg.error = null;
    } catch (err) {
      leg.status = IndexLegStatus.failed;
      leg.error = (err as Error).message.slice(0, 500);
      if (err instanceof SwapNotBroadcastError) {
        // Never reached the chain: the next attempt may re-plan at once.
        leg.broadcast = false;
        leg.deadline = null;
      }
      throw err;
    } finally {
      await this.rebalanceRepository.update({ id: run.id }, { legs: run.legs });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Every index route resolves its vault through here. Drafts and deleted rows
   * are invisible: the basket of an unpublished draft is its owner's private
   * configuration and is served only by the authenticated draft endpoint.
   */
  async requireIndexVault(vaultId: string): Promise<Vault> {
    const vault = await this.vaultRepository.findOne({
      where: {
        id: vaultId,
        deleted: false,
        vault_status: Not(VaultStatus.draft),
      },
    });
    if (!vault) throw new NotFoundException(`Vault ${vaultId} not found`);
    if (vault.vault_archetype !== VaultArchetype.index_weighted) {
      throw new BadRequestException('This vault is not an index-weighted vault');
    }
    return vault;
  }

  private planOptions(config: IndexConfig | null | undefined, reserveBps: number): PlanOptions {
    return {
      reserveBps,
      driftToleranceBps: config?.driftToleranceBps ?? INDEX_DEFAULT_DRIFT_TOLERANCE_BPS,
      minTradeNative: MIN_TRADE_NATIVE,
    };
  }

  private operationId(vaultId: string, key: string, index: number): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }],
        ['L4VA.IndexRebalance', vaultId, key, BigInt(index)]
      )
    );
  }

  private serializePlanningSkip(
    skipped: SkippedLeg,
    targets: IndexTarget[],
    minTradeNative: bigint
  ): IndexRebalanceSkippedLeg {
    const target = targets.find(item => item.assetAddress.toLowerCase() === skipped.asset.toLowerCase());
    return {
      asset: skipped.asset.toLowerCase(),
      symbol: target?.symbol ?? `${skipped.asset.slice(0, 6)}…${skipped.asset.slice(-4)}`,
      side: skipped.side === 'sell' ? IndexLegSide.sell : IndexLegSide.buy,
      reason: skipped.reason,
      valueNative: skipped.valueNative.toString(),
      minTradeNative: minTradeNative.toString(),
    };
  }

  private logPlanningSkips(runId: string, vaultId: string, skipped: IndexRebalanceSkippedLeg[]): void {
    for (const item of skipped) {
      const value = formatUnits(BigInt(item.valueNative), 18);
      const minimum = formatUnits(BigInt(item.minTradeNative), 18);
      const prefix = `Index rebalance ${runId} for vault ${vaultId}: ${item.symbol} ${item.side} skipped`;
      if (item.reason === 'within_tolerance') {
        this.logger.debug(`${prefix} — within_tolerance (drift=${value} ETH)`);
      } else if (item.reason === 'below_min_trade') {
        this.logger.warn(`${prefix} — below_min_trade (value=${value} ETH, minimum=${minimum} ETH)`);
      } else {
        this.logger.warn(`${prefix} — no_free_native (required=${value} ETH above cash reserve)`);
      }
    }
  }

  serializeRebalance(run: EvmIndexRebalance): {
    id: string;
    trigger: IndexRebalanceTrigger;
    proposalId: string | null;
    status: IndexRebalanceStatus;
    phase: IndexRebalancePhase;
    navNative: string | null;
    legs: IndexRebalanceLeg[];
    skipped: IndexRebalanceSkippedLeg[];
    attempts: number;
    lastError: string | null;
    createdAt: Date;
    completedAt: Date | null;
  } {
    return {
      id: run.id,
      trigger: run.trigger,
      proposalId: run.proposal_id ?? null,
      status: run.status,
      phase: run.phase,
      navNative: run.nav_native ?? null,
      legs: run.legs,
      skipped: run.skipped_legs ?? [],
      attempts: run.attempts,
      lastError: run.last_error ?? null,
      createdAt: run.created_at,
      completedAt: run.completed_at ?? null,
    };
  }
}

/** Reject a basket token whose route check did not pass, with a reason users can act on. */
function assertTradable(symbol: string, check: AssetRouteCheck): void {
  if (check.status === 'ok') return;
  if (check.status === 'unavailable') {
    throw new BadRequestException(
      `Could not check whether ${symbol} can be traded: ${check.reason ?? 'Uniswap did not answer'}. Please try again shortly.`
    );
  }
  throw new BadRequestException(`${symbol} cannot be held in an index vault: ${check.reason ?? 'no Uniswap route'}.`);
}
