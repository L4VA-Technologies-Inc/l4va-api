import * as fs from 'fs';
import * as path from 'path';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseError, ContractFunctionRevertedError, parseAbi, type Address } from 'viem';

import {
  TOKEN_CHART_INTERVALS,
  TokenChartInterval,
  TokenDetail,
  TokenOhlcvPoint,
  TokenOverviewField,
  TokenSource,
  TokenSwap,
} from './dto/token-detail.dto';

import { Market } from '@/database/market.entity';
import { MarketService } from '@/modules/market/market.service';
import { PriceService } from '@/modules/price/price.service';
import { TapToolsClient } from '@/modules/taptools/taptools.client';
import { EvmContractReader } from '@/modules/vaults/processing-tx/onchain/evm-contract-reader.service';
import { getEvmLpAdapterAddress } from '@/modules/vaults/processing-tx/onchain/evm-lp.config';
import { VAULT_ABI } from '@/modules/vaults/processing-tx/onchain/vault.abi';
import { MarketTokenKind } from '@/types/market.types';
import { ChainType } from '@/types/vault.types';

type SeedCoin = { id: string; symbol: string; name: string; image: string };

type CardanoSeed = {
  id: string;
  policy_id: string;
  asset_name: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  supply: number | null;
  circulating_supply: number | null;
  image: string | null;
  is_verified?: boolean;
};

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private seed: SeedCoin[] | null = null;
  private mainnetBlockfrost: BlockFrostAPI | null = null;
  /** Vault address → its ERC-20 vault token. Immutable on-chain, so cached forever. */
  private readonly vaultTokenByVault = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly priceService: PriceService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly marketService: MarketService,
    private readonly evmContractReader: EvmContractReader
  ) {}

  private getMainnetBlockfrost(): BlockFrostAPI {
    if (!this.mainnetBlockfrost) {
      const isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
      const projectId =
        this.configService.get<string>('BLOCKFROST_API_KEY_MAINNET') ||
        (isMainnet ? this.configService.get<string>('BLOCKFROST_API_KEY') : undefined);
      if (!projectId) {
        throw new Error('BLOCKFROST_API_KEY_MAINNET is not configured');
      }
      this.mainnetBlockfrost = new BlockFrostAPI({ projectId });
    }
    return this.mainnetBlockfrost;
  }

  private resolveSeedPath(filename: string): string {
    const candidates = [
      path.join(__dirname, '../../data/demo-assets', filename),
      path.join(process.cwd(), 'src/data/demo-assets', filename),
      path.join(process.cwd(), 'dist/data/demo-assets', filename),
    ];
    const filePath = candidates.find(p => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`${filename} not found`);
    }
    return filePath;
  }

  private loadJson<T>(filename: string): T {
    return JSON.parse(fs.readFileSync(this.resolveSeedPath(filename), 'utf8')) as T;
  }

  private loadSeed(): SeedCoin[] {
    if (this.seed) return this.seed;
    this.seed = this.loadJson<SeedCoin[]>('coingecko-memecoins.json');
    return this.seed;
  }

  private loadCardanoSeed(): CardanoSeed[] {
    // Always re-read — seed is small and may be refreshed with images/metadata
    return this.loadJson<CardanoSeed[]>('cardano-memecoins.json');
  }

  private async getFxRates() {
    const [ethUsd, adaUsd] = await Promise.all([
      this.priceService.getEthPrice().catch(() => 3000),
      this.priceService.getAdaPrice().catch(() => 0.5),
    ]);
    return {
      ethUsd: ethUsd > 0 ? ethUsd : 3000,
      adaUsd: adaUsd > 0 ? adaUsd : 0.5,
    };
  }

  private denom(usd: number | null | undefined, ethUsd: number, adaUsd: number) {
    if (usd == null || Number.isNaN(Number(usd))) {
      return { eth: null as number | null, ada: null as number | null };
    }
    const n = Number(usd);
    return { eth: n / ethUsd, ada: n / adaUsd };
  }

  private async mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async getCardanoMemecoin(id: string) {
    const coin = await this.resolveCardanoCoin(id);
    const [listItem] = await this.enrichCardanoCoins([coin]);
    return listItem;
  }

  /** Seed first, then mainnet Blockfrost (policy ID or full unit). */
  private async resolveCardanoCoin(id: string): Promise<CardanoSeed> {
    const needle = String(id || '')
      .trim()
      .toLowerCase();
    const seed = this.loadCardanoSeed();
    const fromSeed = seed.find(c => c.id.toLowerCase() === needle || c.policy_id.toLowerCase() === needle);
    if (fromSeed) return fromSeed;

    if (!/^[0-9a-f]{56,}$/i.test(needle)) {
      throw new NotFoundException(`Cardano token ${id} not found`);
    }

    try {
      const bf = this.getMainnetBlockfrost();
      let unit = needle;
      if (needle.length === 56) {
        const assets = await bf.assetsPolicyById(needle, { count: 100, order: 'desc' });
        const ranked = (assets || [])
          .map(a => ({ asset: a.asset, quantity: BigInt(a.quantity || '0') }))
          .filter(a => a.quantity > 0n)
          .sort((a, b) => (a.quantity < b.quantity ? 1 : a.quantity > b.quantity ? -1 : 0));
        if (!ranked.length) {
          throw new NotFoundException(`Cardano token ${id} not found`);
        }
        unit = ranked[0].asset;
      }

      const asset = await bf.assetsById(unit);
      const policyId = String(asset.policy_id || '').toLowerCase();
      const assetName = String(asset.asset_name || '').toLowerCase();
      const meta = (asset.metadata || {}) as Record<string, unknown>;
      const onchain = (asset.onchain_metadata || {}) as Record<string, unknown>;
      const decimals = Number(meta.decimals ?? 0) || 0;
      const rawQty = BigInt(asset.quantity || '0');
      const divisor = 10n ** BigInt(Math.max(0, decimals));
      const supply = divisor > 0n ? Number(rawQty) / Number(divisor) : Number(rawQty);
      const logo = typeof meta.logo === 'string' ? meta.logo : null;
      const image =
        logo && /^https?:\/\//i.test(logo)
          ? logo
          : logo && logo.length > 32 && logo.length < 20_000
            ? `data:image/png;base64,${logo}`
            : null;

      return {
        id: `${policyId}${assetName}`,
        policy_id: policyId,
        asset_name: assetName,
        symbol: String(meta.ticker || onchain.ticker || '').trim() || null,
        name: String(meta.name || onchain.name || meta.ticker || '').trim() || null,
        decimals,
        supply: Number.isFinite(supply) ? supply : null,
        circulating_supply: Number.isFinite(supply) ? supply : null,
        image,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Mainnet Cardano token lookup failed for ${id}: ${message}`);
      throw new NotFoundException(`Cardano token ${id} not found`);
    }
  }

  private async enrichCardanoCoins(seed: CardanoSeed[]) {
    const units = seed.map(t => t.id);
    const { ethUsd, adaUsd } = await this.getFxRates();

    let priceAda = new Map<string, number | null>();
    try {
      priceAda = await this.tapToolsClient.getMainnetTokenPrices(units);
    } catch (error) {
      this.logger.error(`DexHunter cardano prices failed: ${error.message}`);
    }

    // 24h series (hourly) → %Δ, sparkline, range, volume
    const ohlcStats = await this.mapWithConcurrency(seed, 8, async coin => {
      try {
        const series = await this.tapToolsClient.getTokenOHLCV(coin.policy_id, coin.asset_name, '1h', 24, {
          forceMainnet: true,
        });
        if (!series?.length) {
          return [coin.id, null] as const;
        }
        const closes = series.map(c => c.close).filter(n => Number.isFinite(n) && n > 0);
        const highs = series.map(c => c.high).filter(n => Number.isFinite(n));
        const lows = series.map(c => c.low).filter(n => Number.isFinite(n));
        const volAda = series.reduce((s, c) => s + (Number(c.volume) || 0), 0);
        const first = closes[0];
        const last = closes[closes.length - 1];
        const change24h = first && last ? ((last - first) / first) * 100 : null;
        return [
          coin.id,
          {
            change_24h: change24h,
            sparkline: closes,
            high_ada: highs.length ? Math.max(...highs) : null,
            low_ada: lows.length ? Math.min(...lows) : null,
            volume_ada: volAda > 0 ? volAda : null,
          },
        ] as const;
      } catch {
        return [coin.id, null] as const;
      }
    });
    const statsByUnit = new Map(ohlcStats);

    return seed.map(coin => {
      const ada = priceAda.get(coin.id) ?? null;
      const priceUsd = ada != null ? ada * adaUsd : null;
      const supply = coin.circulating_supply || coin.supply;
      const fdvAda = ada != null && supply ? ada * Number(supply) : null;
      const fdvUsd = fdvAda != null ? fdvAda * adaUsd : null;
      const priceFx = this.denom(priceUsd, ethUsd, adaUsd);
      const fdvFx = this.denom(fdvUsd, ethUsd, adaUsd);
      const stats = statsByUnit.get(coin.id);
      const highUsd = stats?.high_ada != null ? stats.high_ada * adaUsd : null;
      const lowUsd = stats?.low_ada != null ? stats.low_ada * adaUsd : null;
      const volUsd = stats?.volume_ada != null ? stats.volume_ada * adaUsd : null;
      const highFx = this.denom(highUsd, ethUsd, adaUsd);
      const lowFx = this.denom(lowUsd, ethUsd, adaUsd);
      const volFx = this.denom(volUsd, ethUsd, adaUsd);

      return {
        id: coin.id,
        policy_id: coin.policy_id,
        asset_name: coin.asset_name,
        symbol: coin.symbol,
        name: coin.name,
        image: coin.image,
        decimals: coin.decimals,
        price_usd: priceUsd,
        price_ada: ada,
        price_eth: priceFx.eth,
        market_cap: fdvUsd,
        market_cap_ada: fdvAda,
        market_cap_eth: fdvFx.eth,
        fdv: fdvUsd,
        fdv_ada: fdvAda,
        fdv_eth: fdvFx.eth,
        volume_24h: volUsd,
        volume_24h_ada: stats?.volume_ada ?? null,
        volume_24h_eth: volFx.eth,
        change_24h: stats?.change_24h ?? null,
        high_24h: highUsd,
        high_24h_ada: stats?.high_ada ?? null,
        high_24h_eth: highFx.eth,
        low_24h: lowUsd,
        low_24h_ada: stats?.low_ada ?? null,
        low_24h_eth: lowFx.eth,
        sparkline: (stats?.sparkline ?? []).map(c => c * adaUsd),
        source: 'dexhunter' as const,
      };
    });
  }

  /** Cardano Tokens list — DexHunter seed + L4VA vault tokens (NAV on testnet, DEX LP on mainnet). */
  async getCardanoMemecoins() {
    const [seed, vaultTokens] = await Promise.all([
      this.enrichCardanoCoins(this.loadCardanoSeed()),
      this.marketService.listVaultLpTokens(ChainType.cardano),
    ]);
    return [...vaultTokens, ...seed];
  }

  async getCardanoMemecoinOhlc(id: string, days = 7) {
    const coin = await this.resolveCardanoCoin(id);

    let interval: '1h' | '1d' | '1w' = '1d';
    let numIntervals = 7;
    if (days <= 1) {
      interval = '1h';
      numIntervals = 24;
    } else if (days <= 7) {
      interval = '1d';
      numIntervals = 7;
    } else if (days <= 30) {
      interval = '1d';
      numIntervals = 30;
    } else if (days <= 90) {
      interval = '1d';
      numIntervals = 90;
    } else {
      interval = '1w';
      numIntervals = 52;
    }

    try {
      const series = await this.tapToolsClient.getTokenOHLCV(coin.policy_id, coin.asset_name, interval, numIntervals, {
        forceMainnet: true,
      });
      const { adaUsd } = await this.getFxRates();
      const ohlcv = (series || []).map(p => ({
        time: p.time,
        // DexHunter candles are ADA-denominated; chart UI shows USD
        open: p.open * adaUsd,
        high: p.high * adaUsd,
        low: p.low * adaUsd,
        close: p.close * adaUsd,
      }));
      return { id, days, ohlcv };
    } catch (error) {
      this.logger.error(`Cardano OHLC failed for ${id}: ${error.message}`);
      return { id, days, ohlcv: [] };
    }
  }

  async getMemecoins() {
    // Legacy CoinGecko globals — kept for optional/old clients; Cardano UI uses getCardanoMemecoins
    const seed = this.loadSeed();
    const ids = seed.map(c => c.id);

    let markets: Awaited<ReturnType<PriceService['getCoinsMarkets']>> = [];
    try {
      markets = await this.priceService.getCoinsMarkets(ids);
    } catch (error) {
      this.logger.error(`CoinGecko markets failed: ${error.message}`);
    }

    const byId = new Map(markets.map(m => [m.id, m]));
    const { ethUsd, adaUsd } = await this.getFxRates();

    return seed.map(coin => {
      const live = byId.get(coin.id);
      const price = this.denom(live?.price_usd, ethUsd, adaUsd);
      const mcap = this.denom(live?.market_cap, ethUsd, adaUsd);
      const fdv = this.denom(live?.fdv, ethUsd, adaUsd);
      const vol = this.denom(live?.volume_24h, ethUsd, adaUsd);
      const high = this.denom(live?.high_24h, ethUsd, adaUsd);
      const low = this.denom(live?.low_24h, ethUsd, adaUsd);
      return {
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        image: live?.image || coin.image,
        price_usd: live?.price_usd ?? null,
        price_eth: price.eth,
        price_ada: price.ada,
        market_cap: live?.market_cap ?? null,
        market_cap_eth: mcap.eth,
        market_cap_ada: mcap.ada,
        fdv: live?.fdv ?? null,
        fdv_eth: fdv.eth,
        fdv_ada: fdv.ada,
        volume_24h: live?.volume_24h ?? null,
        volume_24h_eth: vol.eth,
        volume_24h_ada: vol.ada,
        change_24h: live?.change_24h ?? null,
        high_24h: live?.high_24h ?? null,
        high_24h_eth: high.eth,
        high_24h_ada: high.ada,
        low_24h: live?.low_24h ?? null,
        low_24h_eth: low.eth,
        low_24h_ada: low.ada,
        sparkline: live?.sparkline ?? [],
        source: 'coingecko' as const,
      };
    });
  }

  async getMemecoin(id: string) {
    const items = await this.getMemecoins();
    const item = items.find(c => c.id === id);
    if (!item) {
      throw new NotFoundException(`Token ${id} not found`);
    }
    return item;
  }

  async getMemecoinOhlc(id: string, days = 7) {
    const seed = this.loadSeed();
    if (!seed.some(c => c.id === id)) {
      throw new NotFoundException(`Token ${id} not found`);
    }

    try {
      const ohlcv = await this.priceService.getCoinOhlc(id, days);
      return { id, days, ohlcv };
    } catch (error) {
      this.logger.error(`CoinGecko OHLC failed for ${id}: ${error.message}`);
      return { id, days, ohlcv: [] };
    }
  }

  private async enrichRobinhoodTokens(
    items: Array<{
      address: string;
      name: string | null;
      symbol: string | null;
      image?: string | null;
      holders_count?: number;
      seed_price_usd?: number | null;
      seed_volume_24h?: number | null;
      seed_liquidity_usd?: number | null;
      seed_change_24h?: number | null;
      seed_fdv?: number | null;
      seed_market_cap?: number | null;
      type?: string | null;
      tags?: string[];
    }>
  ) {
    let live = new Map<string, any>();
    try {
      live = await this.priceService.getDexScreenerMarkets(items.map(i => i.address));
    } catch (error) {
      this.logger.error(`DexScreener markets failed: ${error.message}`);
    }

    const { ethUsd, adaUsd } = await this.getFxRates();

    return items.map(item => {
      const m = live.get(item.address.toLowerCase());
      const priceUsd = m?.price_usd ?? item.seed_price_usd ?? null;
      const marketCap = m?.market_cap ?? item.seed_market_cap ?? null;
      const fdvVal = m?.fdv ?? item.seed_fdv ?? null;
      const volume = m?.volume_24h ?? item.seed_volume_24h ?? null;
      const liquidity = m?.liquidity_usd ?? item.seed_liquidity_usd ?? null;
      const price = this.denom(priceUsd, ethUsd, adaUsd);
      const mcap = this.denom(marketCap, ethUsd, adaUsd);
      const fdv = this.denom(fdvVal, ethUsd, adaUsd);
      const vol = this.denom(volume, ethUsd, adaUsd);
      const liq = this.denom(liquidity, ethUsd, adaUsd);
      return {
        id: item.address.toLowerCase(),
        address: item.address.toLowerCase(),
        symbol: item.symbol,
        name: item.name,
        image: item.image ?? null,
        holders_count: item.holders_count ?? null,
        type: item.type ?? null,
        tags: item.tags ?? [],
        price_usd: priceUsd,
        price_eth: price.eth,
        price_ada: price.ada,
        market_cap: marketCap,
        market_cap_eth: mcap.eth,
        market_cap_ada: mcap.ada,
        fdv: fdvVal,
        fdv_eth: fdv.eth,
        fdv_ada: fdv.ada,
        volume_24h: volume,
        volume_24h_eth: vol.eth,
        volume_24h_ada: vol.ada,
        liquidity_usd: liquidity,
        liquidity_eth: liq.eth,
        liquidity_ada: liq.ada,
        change_24h: m?.change_24h ?? item.seed_change_24h ?? null,
        high_24h: null,
        low_24h: null,
        sparkline: [] as number[],
        pair_address: m?.pair_address ?? null,
        source: 'robinhood' as const,
      };
    });
  }

  /** Seed tokens carry no vault tags, so the Tokens page filters on the tag their JSON category implies. */
  private tagsForTokenKind(kind: MarketTokenKind | null): string[] {
    if (kind === MarketTokenKind.rwa) return ['RWA'];
    if (kind === MarketTokenKind.memecoin) return ['Memecoins'];
    return [];
  }

  private marketToTokenSeed(market: Market) {
    const toNum = (value: unknown): number | null => {
      if (value == null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    return {
      address: market.contract_address!,
      name: market.name,
      symbol: market.symbol,
      image: market.image_url,
      holders_count: market.holders_count ?? undefined,
      seed_price_usd: toNum(market.price_usd),
      seed_volume_24h: toNum(market.volume_24h),
      seed_liquidity_usd: toNum(market.liquidity_usd),
      seed_change_24h: toNum(market.price_change_24h),
      seed_fdv: toNum(market.fdv),
      seed_market_cap: toNum(market.mcap),
      tags: this.tagsForTokenKind(market.token_kind),
    };
  }

  private mapRobinhoodNft(market: Market) {
    return {
      id: market.contract_address!.toLowerCase(),
      address: market.contract_address!.toLowerCase(),
      symbol: market.symbol,
      name: market.name,
      image: market.image_url,
      holders_count: market.holders_count ?? null,
      total_supply: market.totalSupply != null ? String(market.totalSupply) : null,
      type: null,
      price_usd: null,
      market_cap: null,
      fdv: null,
      volume_24h: null,
      liquidity_usd: null,
      change_24h: null,
      high_24h: null,
      low_24h: null,
      sparkline: [],
      source: 'robinhood' as const,
      asset_class: 'nft' as const,
    };
  }

  async getRobinhoodMemecoins() {
    const seed = await this.marketService.listRobinhoodTokens(MarketTokenKind.memecoin);
    const [enriched, vaultTokens] = await Promise.all([
      this.enrichRobinhoodTokens(seed.filter(t => !!t.contract_address).map(t => this.marketToTokenSeed(t))),
      this.marketService.listVaultLpTokens(ChainType.robinhood),
    ]);
    return [...vaultTokens, ...enriched];
  }

  async getRobinhoodRwas() {
    const seed = await this.marketService.listRobinhoodTokens(MarketTokenKind.rwa);
    return this.enrichRobinhoodTokens(seed.filter(t => !!t.contract_address).map(t => this.marketToTokenSeed(t)));
  }

  async getRobinhoodNfts() {
    const seed = await this.marketService.listRobinhoodTokens(MarketTokenKind.nft);
    return seed.filter(t => !!t.contract_address).map(t => this.mapRobinhoodNft(t));
  }

  async getRobinhoodToken(address: string) {
    const key = address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(key) || key === '0x0000000000000000000000000000000000000000') {
      throw new NotFoundException(`Robinhood token ${address} not found`);
    }

    const market = await this.marketService.findRobinhoodTokenByContract(key);
    if (!market?.contract_address) {
      throw new NotFoundException(`Robinhood token ${address} not found`);
    }

    if (market.token_kind === MarketTokenKind.nft) {
      return this.mapRobinhoodNft(market);
    }

    const [item] = await this.enrichRobinhoodTokens([this.marketToTokenSeed(market)]);
    return item;
  }

  async getRobinhoodTokenOhlc(address: string, days = 7) {
    const token = await this.getRobinhoodToken(address);
    const pairAddress = (token as any).pair_address;
    if (!pairAddress) {
      return { id: address.toLowerCase(), days, ohlcv: [] };
    }

    // Map UI "days" window → GeckoTerminal timeframe/aggregate/limit
    let timeframe: 'minute' | 'hour' | 'day' = 'hour';
    let aggregate = 1;
    let limit = 168;
    if (days <= 1) {
      timeframe = 'hour';
      aggregate = 1;
      limit = 24;
    } else if (days <= 7) {
      timeframe = 'hour';
      aggregate = 1;
      limit = 168;
    } else if (days <= 30) {
      timeframe = 'day';
      aggregate = 1;
      limit = 30;
    } else if (days <= 90) {
      timeframe = 'day';
      aggregate = 1;
      limit = 90;
    } else {
      timeframe = 'day';
      aggregate = 1;
      limit = 365;
    }

    try {
      const ohlcv = await this.priceService.getGeckoTerminalOhlc(pairAddress, {
        timeframe,
        aggregate,
        limit,
      });
      return { id: address.toLowerCase(), days, ohlcv, pair_address: pairAddress };
    } catch (error) {
      this.logger.error(`GeckoTerminal OHLC failed for ${address}: ${error.message}`);
      return { id: address.toLowerCase(), days, ohlcv: [], pair_address: pairAddress };
    }
  }

  async getRobinhoodTokenTrades(address: string, limit = 40) {
    const token = await this.getRobinhoodToken(address);
    const pairAddress = (token as any).pair_address;
    if (!pairAddress) {
      return { id: address.toLowerCase(), trades: [] };
    }

    try {
      const trades = await this.priceService.getGeckoTerminalTrades(pairAddress, address, limit);
      return { id: address.toLowerCase(), pair_address: pairAddress, trades };
    } catch (error) {
      this.logger.error(`GeckoTerminal trades failed for ${address}: ${error.message}`);
      return { id: address.toLowerCase(), pair_address: pairAddress, trades: [] };
    }
  }

  /**
   * Unified token detail for TokenDetailPage.
   * Detects vault / Robinhood / Cardano / CoinGecko and returns one page-ready payload.
   */
  async getTokenDetail(id: string): Promise<TokenDetail> {
    const kind = this.detectTokenKind(id);

    if (kind === 'vault') {
      return this.toVaultTokenDetail(await this.loadVaultTokenRow(id));
    }

    if (kind === 'robinhood') {
      try {
        return this.toMarketTokenDetail(await this.getRobinhoodToken(id), 'robinhood', id);
      } catch (error) {
        if (error instanceof NotFoundException) {
          try {
            return this.toVaultTokenDetail(await this.loadVaultTokenRow(id));
          } catch {
            throw error;
          }
        }
        throw error;
      }
    }

    if (kind === 'cardano') {
      return this.toMarketTokenDetail(await this.getCardanoMemecoin(id), 'cardano', id);
    }

    return this.toMarketTokenDetail(await this.getMemecoin(id), 'coingecko', id);
  }

  async getTokenOhlc(
    id: string,
    interval: string = '1d'
  ): Promise<{ id: string; interval: string; ohlcv: TokenOhlcvPoint[] }> {
    const safeInterval = this.parseChartInterval(interval);
    const kind = this.detectTokenKind(id);
    const days = INTERVAL_TO_DAYS[safeInterval];

    if (kind === 'vault') {
      return this.getVaultOhlc(id, safeInterval, days);
    }

    if (kind === 'robinhood') {
      try {
        const result = await this.getRobinhoodTokenOhlc(id, days);
        return { id: result.id, interval: safeInterval, ohlcv: result.ohlcv || [] };
      } catch (error) {
        if (error instanceof NotFoundException) {
          // Not a listed Robinhood memecoin — it may be a vault token opened by its address
          // (the market row's contract_address), so use the vault path (Uniswap pool via GT).
          try {
            return await this.getVaultOhlc(id, safeInterval, days);
          } catch {
            throw error;
          }
        }
        throw error;
      }
    }

    if (kind === 'cardano') {
      const result = await this.getCardanoMemecoinOhlc(id, days);
      return { id: result.id, interval: safeInterval, ohlcv: result.ohlcv || [] };
    }

    const result = await this.getMemecoinOhlc(id, days);
    return { id: result.id, interval: safeInterval, ohlcv: result.ohlcv || [] };
  }

  async getTokenTrades(id: string, limit = 40) {
    const kind = this.detectTokenKind(id);
    if (kind === 'vault') {
      return this.getVaultTrades(id, limit);
    }
    if (kind !== 'robinhood') {
      return { id, trades: [] as Array<Record<string, unknown>> };
    }

    try {
      const result = await this.getRobinhoodTokenTrades(id, limit);
      return {
        id: result.id,
        pair_address: (result as { pair_address?: string }).pair_address ?? null,
        trades: (result.trades || []).map(trade => ({
          ...trade,
          tx_url: trade.tx_hash ? `https://robinhoodchain.blockscout.com/tx/${trade.tx_hash}` : null,
        })),
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        // Vault token opened by its address — not in the memecoin list, but has a Uniswap pool.
        return this.getVaultTrades(id, limit);
      }
      throw error;
    }
  }

  /** Vault chart: Uniswap pool candles (GeckoTerminal) when the vault token trades, else vault NAV. */
  private async getVaultOhlc(id: string, interval: TokenChartInterval, days: number) {
    const evmToken = await this.findEvmVaultTokenAddress(id);
    if (evmToken) {
      const result = await this.getEvmVaultTokenOhlc(evmToken, days);
      if (result.ohlcv.length) return { id, interval, ohlcv: result.ohlcv };
    }
    return this.getVaultTokenOhlcUsd(id, interval);
  }

  /**
   * Vault token trades. GeckoTerminal's pool trades only cover the last 24 hours, so older trades
   * come from the token's transfer history on Blockscout (VT moving into or out of the pool).
   * `id` = vault id or token address.
   */
  private async getVaultTrades(id: string, limit: number) {
    const evmToken = await this.findEvmVaultTokenAddress(id);
    if (!evmToken) return { id, trades: [] as Array<Record<string, unknown>> };
    const pairAddress = await this.findEvmPairAddress(evmToken);
    if (!pairAddress) return { id, trades: [] as Array<Record<string, unknown>> };

    let recent: Array<Record<string, any>> = [];
    try {
      recent = await this.priceService.getGeckoTerminalTrades(pairAddress, evmToken, limit);
    } catch (error) {
      this.logger.error(`GeckoTerminal trades failed for vault token ${evmToken}: ${error.message}`);
    }

    let history: Array<Record<string, any>> = [];
    if (recent.length < limit) {
      try {
        history = await this.getPoolTransferTrades(evmToken, pairAddress, limit);
      } catch (error) {
        this.logger.warn(`Trade history unavailable for vault token ${evmToken}: ${error.message}`);
      }
    }

    // GeckoTerminal rows carry exact prices, so they win over the history row for the same tx.
    const byTx = new Map<string, Record<string, any>>();
    for (const trade of [...history, ...recent]) byTx.set(trade.tx_hash, trade);
    const trades = [...byTx.values()]
      .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
      .slice(0, limit);

    return {
      id,
      pair_address: pairAddress,
      trades: trades.map(trade => ({
        ...trade,
        tx_url: trade.tx_hash ? `https://robinhoodchain.blockscout.com/tx/${trade.tx_hash}` : null,
      })),
    };
  }

  /**
   * Swaps reconstructed from VT transfers to/from the pool: from the pool = buy, into it = sell.
   * The pool is the V2 pair itself, or the v4 PoolManager when `pairAddress` is a v4 pool id.
   * Transfers with the LP adapter / PositionManager are liquidity moves, not trades. The price is the pool candle
   * close at the trade time (hourly for the last week, daily before that).
   */
  private async getPoolTransferTrades(token: string, pairAddress: string, limit: number) {
    const adapter = getEvmLpAdapterAddress()?.toLowerCase() ?? null;
    const pool = await this.resolvePoolHolder(pairAddress, adapter);
    if (!pool) return [];

    const liquidityMovers = new Set<string>(adapter ? [adapter] : []);
    if (adapter && pool !== pairAddress.toLowerCase()) {
      // v4 liquidity is settled through the PositionManager, not the adapter itself.
      try {
        const positionManager = (await this.evmContractReader.publicClient.readContract({
          address: adapter as Address,
          abi: parseAbi(['function positionManager() view returns (address)']),
          functionName: 'positionManager',
        })) as string;
        liquidityMovers.add(positionManager.toLowerCase());
      } catch {
        // Without it LP moves may show as trades; trades themselves are unaffected.
      }
    }
    const transfers = await this.fetchTokenTransfers(token, pool, liquidityMovers, limit);
    if (!transfers.length) return [];

    const [hourly, daily] = await Promise.all([
      this.getEvmVaultTokenOhlc(token, 7).then(r => r.ohlcv),
      this.getEvmVaultTokenOhlc(token, 365).then(r => r.ohlcv),
    ]);
    const weekAgo = Date.now() / 1000 - 7 * 86_400;
    const closeAt = (candles: TokenOhlcvPoint[], time: number): number | null => {
      let close: number | null = null;
      for (const candle of candles) {
        if (candle.time > time) break;
        close = Number(candle.close);
      }
      return close;
    };

    return transfers.map(transfer => {
      const time = (Date.parse(transfer.timestamp) || 0) / 1000;
      const priceUsd = closeAt(time >= weekAgo ? hourly : daily, time) ?? closeAt(daily, time);
      return {
        tx_hash: transfer.tx_hash,
        kind: transfer.kind,
        price_usd: priceUsd,
        amount_token: transfer.amount,
        volume_usd: priceUsd != null ? priceUsd * transfer.amount : null,
        timestamp: transfer.timestamp,
        trader: transfer.trader,
        block_number: transfer.block_number,
      };
    });
  }

  private readonly poolHolderByPair = new Map<string, string>();

  private async resolvePoolHolder(pairAddress: string, adapter: string | null): Promise<string | null> {
    const key = pairAddress.toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(key)) return key;
    const cached = this.poolHolderByPair.get(key);
    if (cached) return cached;
    if (!adapter) return null;
    const poolManager = (await this.evmContractReader.publicClient.readContract({
      address: adapter as Address,
      abi: parseAbi(['function poolManager() view returns (address)']),
      functionName: 'poolManager',
    })) as string;
    const normalized = poolManager.toLowerCase();
    this.poolHolderByPair.set(key, normalized);
    return normalized;
  }

  private blockscoutBases(): string[] {
    const testnet = 'https://explorer.testnet.chain.robinhood.com/api/v2';
    const mainnet = 'https://robinhoodchain.blockscout.com/api/v2';
    if (this.configService.get<string>('ROBINHOOD_RPC_URL', '').toLowerCase().includes('testnet')) return [testnet];
    // The explorer domain can sit behind a Cloudflare challenge; the PRO API does not.
    const pro = this.configService.get<string>('BLOCKSCOUT_API_KEY')?.trim()
      ? ['https://api.blockscout.com/4663/api/v2']
      : [];
    return [...pro, mainnet];
  }

  private async fetchTokenTransfers(token: string, pool: string, liquidityMovers: Set<string>, limit: number) {
    const MAX_PAGES = 10;
    const apiKey = this.configService.get<string>('BLOCKSCOUT_API_KEY')?.trim();
    const errors: string[] = [];

    for (const base of this.blockscoutBases()) {
      try {
        const trades: Array<{
          tx_hash: string;
          kind: 'buy' | 'sell';
          amount: number;
          timestamp: string;
          trader: string | null;
          block_number: number | null;
        }> = [];
        let next: Record<string, unknown> | null = null;
        for (let page = 0; page < MAX_PAGES && trades.length < limit; page += 1) {
          const url = new URL(`${base}/tokens/${token}/transfers`);
          if (next) Object.entries(next).forEach(([k, v]) => url.searchParams.set(k, String(v)));
          if (apiKey && url.hostname === 'api.blockscout.com') url.searchParams.set('apikey', apiKey);
          const response = await fetch(url.toString(), {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { items?: any[]; next_page_params?: Record<string, unknown> | null };

          for (const item of body.items ?? []) {
            const from = String(item.from?.hash ?? '').toLowerCase();
            const to = String(item.to?.hash ?? '').toLowerCase();
            const isBuy = from === pool;
            if (!isBuy && to !== pool) continue;
            const counterparty = isBuy ? to : from;
            if (liquidityMovers.has(counterparty)) continue;
            const decimals = Number(item.total?.decimals ?? 18);
            const amount = Number(item.total?.value ?? 0) / 10 ** decimals;
            if (!(amount > 0)) continue;
            trades.push({
              tx_hash: item.transaction_hash ?? item.tx_hash ?? '',
              kind: isBuy ? 'buy' : 'sell',
              amount,
              timestamp: item.timestamp ?? null,
              trader: counterparty || null,
              block_number: item.block_number != null ? Number(item.block_number) : null,
            });
          }

          next = body.next_page_params ?? null;
          if (!next) break;
        }
        return trades.slice(0, limit);
      } catch (error) {
        errors.push(`${base}: ${(error as Error).message}`);
      }
    }
    throw new Error(`Blockscout transfers failed: ${errors.join(' | ')}`);
  }

  /** Vault market row with the EVM vault-token address resolved (the market row only stores the vault address). */
  private async loadVaultTokenRow(id: string) {
    const row = await this.marketService.getVaultTokenById(id);
    // evm-market-stats overwrites contract_address with the vault token once the LP is live;
    // before that it is still the vault address. vaultToken() only succeeds on the vault.
    const tokenAddress =
      row.chain_type === 'robinhood' && row.contract_address
        ? ((await this.resolveVaultTokenAddress(row.contract_address)) ?? row.contract_address.toLowerCase())
        : null;
    return { ...row, token_address: tokenAddress };
  }

  private async findEvmVaultTokenAddress(id: string): Promise<string | null> {
    try {
      return (await this.loadVaultTokenRow(id)).token_address;
    } catch {
      return null;
    }
  }

  private async resolveVaultTokenAddress(vaultAddress: string): Promise<string | null> {
    const key = vaultAddress.toLowerCase();
    const cached = this.vaultTokenByVault.get(key);
    if (cached) return cached;
    try {
      const token = (await this.evmContractReader.publicClient.readContract({
        address: vaultAddress,
        abi: VAULT_ABI,
        functionName: 'vaultToken',
      })) as string;
      if (!token || /^0x0{40}$/i.test(token)) return null;
      const normalized = token.toLowerCase();
      this.vaultTokenByVault.set(key, normalized);
      return normalized;
    } catch (error) {
      // A revert means the address is not a vault — after the LP goes live evm-market-stats
      // stores the vault token itself in contract_address. Cache it as its own token so we
      // don't hit the RPC (and revert) on every request. Transient RPC errors are not cached.
      if (error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError)) {
        this.vaultTokenByVault.set(key, key);
        return key;
      }
      this.logger.debug(`vaultToken() read failed for ${vaultAddress}: ${error.message}`);
      return null;
    }
  }

  private async findEvmPairAddress(tokenAddress: string): Promise<string | null> {
    const markets = await this.priceService.getDexScreenerMarkets([tokenAddress]);
    const pair = markets.get(tokenAddress.toLowerCase())?.pair_address ?? null;
    return pair ?? (await this.priceService.findGeckoTerminalTopPool(tokenAddress));
  }

  private async getEvmVaultTokenOhlc(tokenAddress: string, days: number) {
    const pairAddress = await this.findEvmPairAddress(tokenAddress);
    if (!pairAddress) return { ohlcv: [] as TokenOhlcvPoint[] };
    const timeframe: 'hour' | 'day' = days <= 7 ? 'hour' : 'day';
    const limit = days <= 1 ? 24 : days <= 7 ? 168 : days;
    try {
      const ohlcv = await this.priceService.getGeckoTerminalOhlc(pairAddress, { timeframe, aggregate: 1, limit });
      return { ohlcv: ohlcv as TokenOhlcvPoint[] };
    } catch (error) {
      this.logger.error(`GeckoTerminal OHLC failed for vault token ${tokenAddress}: ${error.message}`);
      return { ohlcv: [] as TokenOhlcvPoint[] };
    }
  }

  private async getVaultTokenOhlcUsd(id: string, interval: TokenChartInterval) {
    const vaultInterval = VAULT_OHLCV_INTERVAL[interval];
    const market = await this.marketService.getMarketByIdWithOHLCV(id, vaultInterval);
    const adaPrice = Number(market.adaPrice) || 0;
    const series = Array.isArray(market.ohlcv) ? market.ohlcv : [];
    const ohlcv = series.map(point => {
      const toUsd = (value: number) => (adaPrice > 0 ? value * adaPrice : value);
      return {
        time: point.time,
        open: toUsd(point.open),
        high: toUsd(point.high),
        low: toUsd(point.low),
        close: toUsd(point.close),
        volume: point.volume,
      };
    });
    return { id: market.vault_id || id, interval, ohlcv };
  }

  private detectTokenKind(id: string): TokenSource {
    const value = String(id || '').trim();
    if (UUID_RE.test(value)) return 'vault';
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) return 'robinhood';
    if (/^[a-fA-F0-9]{56,}$/i.test(value)) return 'cardano';
    return 'coingecko';
  }

  private parseChartInterval(interval?: string): TokenChartInterval {
    const value = String(interval || '1d').toLowerCase();
    return TOKEN_CHART_INTERVALS.includes(value as TokenChartInterval) ? (value as TokenChartInterval) : '1d';
  }

  private toVaultTokenDetail(row: Awaited<ReturnType<TokensService['loadVaultTokenRow']>>): TokenDetail {
    const copyValue = this.buildVaultCopyValue(row);
    const swap = this.buildVaultSwap(row, copyValue);
    const isEvmToken = Boolean(row.token_address);
    return {
      id: row.vault_id || row.id,
      source: 'vault',
      name: row.name ?? null,
      symbol: row.symbol ?? null,
      image: row.image ?? null,
      price_usd: row.price_usd ?? null,
      price_eth: row.price_eth ?? null,
      price_ada: row.price_ada ?? null,
      market_cap: row.market_cap ?? null,
      market_cap_eth: row.market_cap_eth ?? null,
      market_cap_ada: row.market_cap_ada ?? null,
      fdv: row.fdv ?? null,
      fdv_eth: row.fdv_eth ?? null,
      fdv_ada: row.fdv_ada ?? null,
      volume_24h: row.volume_24h ?? null,
      volume_24h_eth: row.volume_24h_eth ?? null,
      volume_24h_ada: row.volume_24h_ada ?? null,
      liquidity_usd: row.liquidity_usd ?? null,
      liquidity_eth: row.liquidity_eth ?? null,
      liquidity_ada: row.liquidity_ada ?? null,
      change_24h: row.change_24h ?? null,
      high_24h: row.high_24h ?? null,
      high_24h_eth: row.high_24h_eth ?? null,
      high_24h_ada: row.high_24h_ada ?? null,
      low_24h: row.low_24h ?? null,
      low_24h_eth: row.low_24h_eth ?? null,
      low_24h_ada: row.low_24h_ada ?? null,
      holders_count: row.holders_count ?? null,
      chain_type: row.chain_type ?? null,
      vault_id: row.vault_id ?? row.id,
      contract_address: row.contract_address ?? null,
      copy_value: copyValue,
      explorer_url: isEvmToken ? this.buildExplorerUrl('robinhood', copyValue) : null,
      has_live_trades: isEvmToken,
      chart_kind: isEvmToken ? 'usd' : 'nav',
      overview_fields: isEvmToken ? ['fdv', 'liquidity', 'mcap', 'holders'] : ['fdv', 'liquidity', 'mcap'],
      swap,
    };
  }

  private toMarketTokenDetail(
    item: Record<string, any>,
    source: Exclude<TokenSource, 'vault'>,
    fallbackId: string
  ): TokenDetail {
    const id = String(item.id || item.address || fallbackId);
    const copyValue = source === 'cardano' ? id : String(item.address || id);
    const swap = this.buildMarketSwap(source, copyValue);
    return {
      id,
      source,
      name: item.name ?? null,
      symbol: item.symbol ?? null,
      image: item.image ?? item.icon_url ?? null,
      price_usd: item.price_usd ?? null,
      price_eth: item.price_eth ?? null,
      price_ada: item.price_ada ?? null,
      market_cap: item.market_cap ?? null,
      market_cap_eth: item.market_cap_eth ?? null,
      market_cap_ada: item.market_cap_ada ?? null,
      fdv: item.fdv ?? null,
      fdv_eth: item.fdv_eth ?? null,
      fdv_ada: item.fdv_ada ?? null,
      volume_24h: item.volume_24h ?? null,
      volume_24h_eth: item.volume_24h_eth ?? null,
      volume_24h_ada: item.volume_24h_ada ?? null,
      liquidity_usd: item.liquidity_usd ?? null,
      liquidity_eth: item.liquidity_eth ?? null,
      liquidity_ada: item.liquidity_ada ?? null,
      change_24h: item.change_24h ?? null,
      high_24h: item.high_24h ?? null,
      high_24h_eth: item.high_24h_eth ?? null,
      high_24h_ada: item.high_24h_ada ?? null,
      low_24h: item.low_24h ?? null,
      low_24h_eth: item.low_24h_eth ?? null,
      low_24h_ada: item.low_24h_ada ?? null,
      holders_count: item.holders_count ?? null,
      chain_type: source === 'robinhood' ? 'robinhood' : source === 'cardano' ? 'cardano' : null,
      vault_id: null,
      contract_address: item.address ?? item.contract_address ?? null,
      copy_value: copyValue,
      explorer_url: this.buildExplorerUrl(source, copyValue),
      has_live_trades: source === 'robinhood',
      chart_kind: 'usd',
      overview_fields: this.overviewFieldsFor(source),
      swap,
    };
  }

  private overviewFieldsFor(source: Exclude<TokenSource, 'vault'>): TokenOverviewField[] {
    if (source === 'robinhood') {
      return ['mcap', 'fdv', 'liquidity', 'holders', 'volume'];
    }
    return ['mcap', 'fdv', 'high', 'low', 'volume'];
  }

  private buildExplorerUrl(source: Exclude<TokenSource, 'vault'>, id: string): string | null {
    if (!id) return null;
    if (source === 'robinhood') return `https://dexscreener.com/robinhood/${id}`;
    if (source === 'cardano') return `https://cardanoscan.io/token/${id}`;
    return `https://www.coingecko.com/en/coins/${id}`;
  }

  private buildMarketSwap(source: Exclude<TokenSource, 'vault'>, copyValue: string): TokenSwap | null {
    if (!copyValue) return null;
    if (source === 'robinhood') {
      return { kind: 'uniswap', token: copyValue };
    }
    if (source === 'cardano') {
      return { kind: 'dexhunter', token: copyValue };
    }
    return null;
  }

  private buildVaultCopyValue(row: {
    chain_type?: string | null;
    contract_address?: string | null;
    token_address?: string | null;
    script_hash?: string | null;
    asset_vault_name?: string | null;
    vault_id?: string | null;
    id?: string | null;
  }): string {
    const fallback = row.vault_id || row.id || '';
    if (row.chain_type === 'robinhood') {
      return row.token_address || row.contract_address || fallback;
    }
    const policyId = row.script_hash || '';
    const assetName = row.asset_vault_name || '';
    if (!policyId && !assetName) return fallback;
    if (assetName && policyId && assetName.startsWith(policyId)) return assetName;
    return `${policyId}${assetName}`;
  }

  private buildVaultSwap(
    row: {
      chain_type?: string | null;
      contract_address?: string | null;
      token_address?: string | null;
      has_active_lp?: boolean;
    },
    copyValue: string
  ): TokenSwap | null {
    if (row.chain_type === 'robinhood' && (row.token_address || row.contract_address)) {
      return { kind: 'uniswap', token: row.token_address || row.contract_address };
    }
    if (row.chain_type === 'cardano' && row.has_active_lp && copyValue) {
      return { kind: 'dexhunter', token: copyValue };
    }
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INTERVAL_TO_DAYS: Record<TokenChartInterval, number> = {
  '1h': 1,
  '1d': 1,
  '1w': 7,
  '1m': 30,
  '3m': 90,
  '1y': 365,
};

const VAULT_OHLCV_INTERVAL: Record<TokenChartInterval, string> = {
  '1h': '1h',
  '1d': '1d',
  '1w': '1w',
  '1m': '1d',
  '3m': '1d',
  '1y': '1w',
};
