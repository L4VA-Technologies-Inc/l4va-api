import * as fs from 'fs';
import * as path from 'path';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  TOKEN_CHART_INTERVALS,
  TokenChartInterval,
  TokenDetail,
  TokenOhlcvPoint,
  TokenOverviewField,
  TokenSource,
  TokenSwap,
} from './dto/token-detail.dto';

import { MarketService } from '@/modules/market/market.service';
import { PriceService } from '@/modules/price/price.service';
import { TapToolsClient } from '@/modules/taptools/taptools.client';
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

type RhMemeSeed = {
  address: string;
  name: string | null;
  symbol: string | null;
  holders_count?: number;
  icon_url?: string | null;
  price_usd?: number | null;
  volume_24h?: number | null;
  liquidity_usd?: number | null;
  price_change_24h?: number | null;
  fdv?: number | null;
  market_cap?: number | null;
};

type RhRwaSeed = {
  id: string | null;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  contract: string | null;
};

type RhNftSeed = {
  address: string;
  name: string | null;
  symbol: string | null;
  type?: string | null;
  logo?: string | null;
  holders_count?: number;
  total_supply?: string | null;
};

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private seed: SeedCoin[] | null = null;
  private rhMemes: RhMemeSeed[] | null = null;
  private rhRwas: RhRwaSeed[] | null = null;
  private rhNfts: RhNftSeed[] | null = null;
  private mainnetBlockfrost: BlockFrostAPI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly priceService: PriceService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly marketService: MarketService
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

  private loadRhMemes(): RhMemeSeed[] {
    if (this.rhMemes) return this.rhMemes;
    this.rhMemes = this.loadJson<RhMemeSeed[]>('robinhood-memecoins.json');
    return this.rhMemes;
  }

  private loadRhRwas(): RhRwaSeed[] {
    if (this.rhRwas) return this.rhRwas;
    this.rhRwas = this.loadJson<RhRwaSeed[]>('robinhood-rwas.json');
    return this.rhRwas;
  }

  private loadRhNfts(): RhNftSeed[] {
    if (this.rhNfts) return this.rhNfts;
    this.rhNfts = this.loadJson<RhNftSeed[]>('robinhood-nfts.json');
    return this.rhNfts;
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

  async getRobinhoodMemecoins() {
    const seed = this.loadRhMemes();
    const [enriched, vaultTokens] = await Promise.all([
      this.enrichRobinhoodTokens(
        seed.map(t => ({
          address: t.address,
          name: t.name,
          symbol: t.symbol,
          image: t.icon_url,
          holders_count: t.holders_count,
          seed_price_usd: t.price_usd,
          seed_volume_24h: t.volume_24h,
          seed_liquidity_usd: t.liquidity_usd,
          seed_change_24h: t.price_change_24h,
          seed_fdv: t.fdv,
          seed_market_cap: t.market_cap,
        }))
      ),
      this.marketService.listVaultLpTokens(ChainType.robinhood),
    ]);
    return [...vaultTokens, ...enriched];
  }

  async getRobinhoodRwas() {
    const seed = this.loadRhRwas();
    return this.enrichRobinhoodTokens(
      seed
        .filter(t => !!t.contract)
        .map(t => ({
          address: t.contract!,
          name: t.name,
          symbol: t.symbol,
          image: t.logo,
        }))
    );
  }

  async getRobinhoodNfts() {
    // NFTs: no DexScreener price — return seed as-is
    return this.loadRhNfts().map(t => ({
      id: t.address.toLowerCase(),
      address: t.address.toLowerCase(),
      symbol: t.symbol,
      name: t.name,
      image: t.logo,
      holders_count: t.holders_count ?? null,
      total_supply: t.total_supply ?? null,
      type: t.type ?? null,
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
    }));
  }

  async getRobinhoodToken(address: string) {
    const key = address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(key) || key === '0x0000000000000000000000000000000000000000') {
      throw new NotFoundException(`Robinhood token ${address} not found`);
    }

    const meme = this.loadRhMemes().find(t => t.address.toLowerCase() === key);
    if (meme) {
      const [item] = await this.enrichRobinhoodTokens([
        {
          address: meme.address,
          name: meme.name,
          symbol: meme.symbol,
          image: meme.icon_url,
          holders_count: meme.holders_count,
          seed_price_usd: meme.price_usd,
          seed_volume_24h: meme.volume_24h,
          seed_liquidity_usd: meme.liquidity_usd,
          seed_change_24h: meme.price_change_24h,
          seed_fdv: meme.fdv,
          seed_market_cap: meme.market_cap,
        },
      ]);
      return item;
    }

    const rwa = this.loadRhRwas().find(t => t.contract?.toLowerCase() === key);
    if (rwa?.contract) {
      const [item] = await this.enrichRobinhoodTokens([
        {
          address: rwa.contract,
          name: rwa.name,
          symbol: rwa.symbol,
          image: rwa.logo,
        },
      ]);
      return item;
    }

    const nft = this.loadRhNfts().find(t => t.address.toLowerCase() === key);
    if (nft) {
      return {
        id: nft.address.toLowerCase(),
        address: nft.address.toLowerCase(),
        symbol: nft.symbol,
        name: nft.name,
        image: nft.logo,
        holders_count: nft.holders_count ?? null,
        total_supply: nft.total_supply ?? null,
        type: nft.type ?? null,
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

    throw new NotFoundException(`Robinhood token ${address} not found`);
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
      return this.toVaultTokenDetail(await this.marketService.getVaultTokenById(id));
    }

    if (kind === 'robinhood') {
      try {
        return this.toMarketTokenDetail(await this.getRobinhoodToken(id), 'robinhood', id);
      } catch (error) {
        if (error instanceof NotFoundException) {
          try {
            return this.toVaultTokenDetail(await this.marketService.getVaultTokenById(id));
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
      return this.getVaultTokenOhlcUsd(id, safeInterval);
    }

    if (kind === 'robinhood') {
      try {
        const result = await this.getRobinhoodTokenOhlc(id, days);
        return { id: result.id, interval: safeInterval, ohlcv: result.ohlcv || [] };
      } catch (error) {
        if (error instanceof NotFoundException) {
          try {
            return this.getVaultTokenOhlcUsd(id, safeInterval);
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
        return { id, trades: [] };
      }
      throw error;
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

  private toVaultTokenDetail(row: Awaited<ReturnType<MarketService['getVaultTokenById']>>): TokenDetail {
    const copyValue = this.buildVaultCopyValue(row);
    const swap = this.buildVaultSwap(row, copyValue);
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
      holders_count: null,
      chain_type: row.chain_type ?? null,
      vault_id: row.vault_id ?? row.id,
      contract_address: row.contract_address ?? null,
      copy_value: copyValue,
      explorer_url: null,
      has_live_trades: false,
      chart_kind: 'nav',
      overview_fields: ['fdv', 'liquidity', 'mcap'],
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
    script_hash?: string | null;
    asset_vault_name?: string | null;
    vault_id?: string | null;
    id?: string | null;
  }): string {
    const fallback = row.vault_id || row.id || '';
    if (row.chain_type === 'robinhood') {
      return row.contract_address || fallback;
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
      has_active_lp?: boolean;
    },
    copyValue: string
  ): TokenSwap | null {
    if (row.chain_type === 'robinhood' && row.contract_address) {
      return { kind: 'uniswap', token: row.contract_address };
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
