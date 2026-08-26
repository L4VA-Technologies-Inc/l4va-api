import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PriceService } from '@/modules/price/price.service';
import { TapToolsClient } from '@/modules/taptools/taptools.client';

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

  constructor(
    private readonly priceService: PriceService,
    private readonly tapToolsClient: TapToolsClient
  ) {}

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
    const seed = this.loadCardanoSeed();
    const coin = seed.find(c => c.id === id);
    if (!coin) throw new NotFoundException(`Cardano token ${id} not found`);

    const [listItem] = await this.enrichCardanoCoins([coin]);
    return listItem;
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

  /** Cardano Tokens list — DexHunter seed + live DexHunter prices (not CoinGecko). */
  async getCardanoMemecoins() {
    return this.enrichCardanoCoins(this.loadCardanoSeed());
  }

  async getCardanoMemecoinOhlc(id: string, days = 7) {
    const seed = this.loadCardanoSeed();
    const coin = seed.find(c => c.id === id);
    if (!coin) throw new NotFoundException(`Cardano token ${id} not found`);

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
    return this.enrichRobinhoodTokens(
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
    );
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
    const [memes, rwas] = await Promise.all([this.getRobinhoodMemecoins(), this.getRobinhoodRwas()]);
    const item = [...memes, ...rwas].find(t => t.address === key);
    if (!item) {
      const nft = (await this.getRobinhoodNfts()).find(t => t.address === key);
      if (!nft) throw new NotFoundException(`Robinhood token ${address} not found`);
      return nft;
    }
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
}
