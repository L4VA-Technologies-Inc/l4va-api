import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import NodeCache from "node-cache";

import { NexusClient } from "@/modules/nexus/nexus.client";

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache = new NodeCache({ stdTTL: 600 });
  private readonly dexHunterApiKey: string;
  private readonly dexHunterBaseUrl: string;
  private readonly coinGeckoApiKey: string;
  private readonly coinGeckoApiUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly nexusClient: NexusClient,
  ) {
    this.dexHunterApiKey = this.configService.get<string>("DEXHUNTER_API_KEY");
    this.dexHunterBaseUrl =
      this.configService.get<string>("DEXHUNTER_BASE_URL");
    this.coinGeckoApiKey = this.configService.get<string>("COINGECKO_API_KEY");
    this.coinGeckoApiUrl = this.configService.get<string>("COINGECKO_API_URL");
  }

  async getAdaPrice(): Promise<number> {
    const cacheKey = "ada_price_usd";
    const cachedPrice = this.cache.get<number>(cacheKey);

    if (cachedPrice !== undefined) {
      return cachedPrice;
    }

    const fallbackPrice = 0.25;

    try {
      const now = Date.now();
      const lastCallKey = "last_price_api_call";
      const lastCall = this.cache.get<number>(lastCallKey) || 0;

      // Rate limiting: don't call API more than once per 10 seconds
      if (now - lastCall < 10000) {
        const lastKnownGoodPrice = this.cache.get<number>(
          "last_known_good_ada_price",
        );
        return lastKnownGoodPrice || fallbackPrice;
      }

      this.cache.set(lastCallKey, now);

      // Call DexHunter API
      try {
        const response = await axios.get(
          `${this.dexHunterBaseUrl}/swap/adaValue`,
          {
            headers: {
              "X-Partner-Id": this.dexHunterApiKey,
            },
            timeout: 5000,
          },
        );

        if (!response.data || typeof response.data !== "number") {
          throw new Error("Invalid price data from DexHunter API");
        }

        const adaPrice = Number(response.data);

        // Cache price for 15 minutes
        this.cache.set(cacheKey, adaPrice, 900);
        this.cache.set("last_known_good_ada_price", adaPrice, 86400);

        return adaPrice;
      } catch (dexHunterError) {
        this.logger.warn(
          `DexHunter API failed: ${dexHunterError.message}. Trying Nexus...`,
        );

        // Fallback to Nexus API using NexusClient
        const adaPrice = await this.nexusClient.getAdaPrice();

        if (adaPrice === null) {
          throw new Error("Both DexHunter and Nexus APIs failed");
        }

        // Cache price for 15 minutes
        this.cache.set(cacheKey, adaPrice, 900);
        this.cache.set("last_known_good_ada_price", adaPrice, 86400);

        this.logger.log(
          `Successfully fetched ADA price from Nexus: $${adaPrice.toFixed(4)}`,
        );
        return adaPrice;
      }
    } catch (error) {
      this.logger.error(`Failed to fetch ADA price: ${error.message}`);

      // If we have a last known good price, use that
      const lastKnownGoodPrice = this.cache.get<number>(
        "last_known_good_ada_price",
      );
      if (lastKnownGoodPrice !== undefined) {
        this.logger.warn(
          `Using last known good ADA price: $${lastKnownGoodPrice.toFixed(4)}`,
        );
        return lastKnownGoodPrice;
      }

      // Use fallback price as last resort
      this.logger.warn(`Using fallback ADA price: $${fallbackPrice}`);
      return fallbackPrice;
    }
  }

  private ethPriceInFlight: Promise<number> | null = null;

  /**
   * ETH/USD with independent sources and no thundering herd:
   *  - fresh cache (15 min) → one shared in-flight request for concurrent callers (cold start used to
   *    hand every parallel caller the hard-coded fallback while the first call was still in flight);
   *  - sources in order: CoinGecko → Coinbase spot → Kraken ticker (no keys needed for the last two);
   *  - all failing: last known good price (7 days), and only then the static fallback, logged as ERROR.
   */
  async getEthPrice(): Promise<number> {
    const cached = this.cache.get<number>("eth_price_usd");
    if (cached !== undefined) return cached;
    if (!this.ethPriceInFlight) {
      this.ethPriceInFlight = this.fetchEthPrice().finally(() => {
        this.ethPriceInFlight = null;
      });
    }
    return this.ethPriceInFlight;
  }

  private async fetchEthPrice(): Promise<number> {
    const sources: Array<{ name: string; fetch: () => Promise<number> }> = [
      {
        name: "CoinGecko",
        fetch: async () => {
          const { data } = await axios.get(
            `${this.coinGeckoApiUrl}/v3/simple/price`,
            {
              params: { ids: "ethereum", vs_currencies: "usd" },
              headers: this.coinGeckoApiKey
                ? { "x-cg-demo-api-key": this.coinGeckoApiKey }
                : {},
              timeout: 5000,
            },
          );
          return Number(data?.ethereum?.usd);
        },
      },
      {
        name: "Coinbase",
        fetch: async () => {
          const { data } = await axios.get(
            "https://api.coinbase.com/v2/prices/ETH-USD/spot",
            { timeout: 5000 },
          );
          return Number(data?.data?.amount);
        },
      },
      {
        name: "Kraken",
        fetch: async () => {
          const { data } = await axios.get(
            "https://api.kraken.com/0/public/Ticker",
            {
              params: { pair: "ETHUSD" },
              timeout: 5000,
            },
          );
          const ticker = data?.result
            ? (Object.values(data.result)[0] as any)
            : null;
          return Number(ticker?.c?.[0]);
        },
      },
    ];

    for (const source of sources) {
      try {
        const price = await source.fetch();
        if (!Number.isFinite(price) || price <= 0)
          throw new Error(`invalid price ${price}`);
        this.cache.set("eth_price_usd", price, 900);
        this.cache.set("last_known_good_eth_price", price, 7 * 86400);
        this.logger.log(`ETH price from ${source.name}: $${price.toFixed(2)}`);
        return price;
      } catch (error) {
        this.logger.warn(
          `ETH price from ${source.name} failed: ${(error as Error).message}`,
        );
      }
    }

    const lastKnownGood = this.cache.get<number>("last_known_good_eth_price");
    if (lastKnownGood !== undefined) {
      this.logger.warn(
        `All ETH price sources failed — using last known good $${lastKnownGood.toFixed(2)}`,
      );
      // Short cache so the sources are retried soon, without hammering them on every call.
      this.cache.set("eth_price_usd", lastKnownGood, 60);
      return lastKnownGood;
    }

    const staticFallback = 3000;
    this.logger.error(
      `All ETH price sources failed and no last known price — using static $${staticFallback}`,
    );
    this.cache.set("eth_price_usd", staticFallback, 60);
    return staticFallback;
  }

  private getCoinGeckoHeaders() {
    return {
      "x-cg-demo-api-key": this.coinGeckoApiKey,
      Accept: "application/json",
    };
  }

  /**
   * Batch market data for CoinGecko coin ids (price, mcap, volume, 24h change, sparkline).
   */
  async getCoinsMarkets(ids: string[]): Promise<
    Array<{
      id: string;
      symbol: string;
      name: string;
      image: string;
      price_usd: number | null;
      market_cap: number | null;
      fdv: number | null;
      volume_24h: number | null;
      change_24h: number | null;
      high_24h: number | null;
      low_24h: number | null;
      sparkline: number[];
    }>
  > {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    const cacheKey = `cg_markets_${uniqueIds.slice().sort().join(",")}`;
    const cached = this.cache.get<any[]>(cacheKey);
    if (cached) return cached;

    const response = await axios.get(
      `${this.coinGeckoApiUrl}/v3/coins/markets`,
      {
        params: {
          vs_currency: "usd",
          ids: uniqueIds.join(","),
          order: "market_cap_desc",
          per_page: Math.min(uniqueIds.length, 250),
          page: 1,
          sparkline: true,
          price_change_percentage: "24h",
        },
        headers: this.getCoinGeckoHeaders(),
        timeout: 15000,
      },
    );

    const mapped = (response.data || []).map((c: any) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      image: c.image,
      price_usd: c.current_price ?? null,
      market_cap: c.market_cap ?? null,
      fdv: c.fully_diluted_valuation ?? null,
      volume_24h: c.total_volume ?? null,
      change_24h: c.price_change_percentage_24h ?? null,
      high_24h: c.high_24h ?? null,
      low_24h: c.low_24h ?? null,
      sparkline: Array.isArray(c.sparkline_in_7d?.price)
        ? c.sparkline_in_7d.price
        : [],
    }));

    this.cache.set(cacheKey, mapped, 120);
    return mapped;
  }

  /**
   * OHLC candles for a single coin. days: 1 | 7 | 14 | 30 | 90 | 180 | 365
   * Returns VaultChart-compatible points: { time, open, high, low, close }
   */
  async getCoinOhlc(
    id: string,
    days: number = 7,
  ): Promise<
    Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }>
  > {
    const cacheKey = `cg_ohlc_${id}_${days}`;
    const cached = this.cache.get<any[]>(cacheKey);
    if (cached) return cached;

    const response = await axios.get(
      `${this.coinGeckoApiUrl}/v3/coins/${id}/ohlc`,
      {
        params: {
          vs_currency: "usd",
          days,
        },
        headers: this.getCoinGeckoHeaders(),
        timeout: 15000,
      },
    );

    const mapped = (response.data || []).map((row: number[]) => ({
      time: Math.floor(row[0] / 1000),
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
    }));

    const normalized = this.normalizeOhlcCandles(mapped);
    this.cache.set(cacheKey, normalized, 120);
    return normalized;
  }

  /**
   * Batch DexScreener market data for Robinhood-chain token addresses.
   * Returns a map keyed by lowercase address.
   */
  async getDexScreenerMarkets(addresses: string[]): Promise<
    Map<
      string,
      {
        price_usd: number | null;
        volume_24h: number | null;
        liquidity_usd: number | null;
        change_24h: number | null;
        fdv: number | null;
        market_cap: number | null;
        pair_address: string | null;
      }
    >
  > {
    const unique = [
      ...new Set(addresses.map((a) => a?.toLowerCase()).filter(Boolean)),
    ];
    const result = new Map<
      string,
      {
        price_usd: number | null;
        volume_24h: number | null;
        liquidity_usd: number | null;
        change_24h: number | null;
        fdv: number | null;
        market_cap: number | null;
        pair_address: string | null;
      }
    >();

    if (unique.length === 0) return result;

    const chainId =
      this.configService.get<string>("DEXSCREENER_CHAIN_ID") ?? "robinhood";
    const cacheKey = `dex_markets_${chainId}_${unique.slice().sort().join(",")}`;
    const cached = this.cache.get<Map<string, any>>(cacheKey);
    if (cached) return cached;

    // Per-token last good market (24h). Used when a DexScreener batch fails, so one outage doesn't
    // blank every Robinhood price / vault chart; a failed run is also never cached as "no markets".
    const staleKey = (address: string) =>
      `dex_market_stale_${chainId}_${address}`;
    let anyBatchFailed = false;

    for (let i = 0; i < unique.length; i += 30) {
      const batch = unique.slice(i, i + 30);
      try {
        const url = `https://api.dexscreener.com/tokens/v1/${chainId}/${batch.join(",")}`;
        const response = await axios.get(url, { timeout: 10000 });
        const pairs: any[] = Array.isArray(response.data) ? response.data : [];

        for (const address of batch) {
          const target = address.toLowerCase();
          const best =
            pairs
              .filter(
                (p) =>
                  p.baseToken?.address?.toLowerCase() === target ||
                  p.quoteToken?.address?.toLowerCase() === target,
              )
              .sort(
                (a, b) =>
                  Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0),
              )[0] ?? null;

          if (best) {
            result.set(target, {
              price_usd: best.priceUsd != null ? Number(best.priceUsd) : null,
              volume_24h:
                best.volume?.h24 != null ? Number(best.volume.h24) : null,
              liquidity_usd:
                best.liquidity?.usd != null ? Number(best.liquidity.usd) : null,
              change_24h:
                best.priceChange?.h24 != null
                  ? Number(best.priceChange.h24)
                  : null,
              fdv: best.fdv != null ? Number(best.fdv) : null,
              market_cap:
                best.marketCap != null ? Number(best.marketCap) : null,
              pair_address: best.pairAddress ?? null,
            });
            this.cache.set(staleKey(target), result.get(target), 86400);
          }
        }
      } catch (error: any) {
        anyBatchFailed = true;
        let restored = 0;
        for (const address of batch) {
          const stale = this.cache.get<any>(staleKey(address));
          if (stale) {
            result.set(address, stale);
            restored++;
          }
        }
        this.logger.warn(
          `DexScreener batch failed: ${error.message} — served ${restored}/${batch.length} from last good data`,
        );
      }
    }

    // Short cache on partial failure so the next call retries DexScreener instead of pinning stale data.
    this.cache.set(cacheKey, result, anyBatchFailed ? 15 : 120);
    return result;
  }

  /**
   * GeckoTerminal OHLCV for a Robinhood-chain pool/pair address.
   * timeframe: minute | hour | day
   */
  async getGeckoTerminalOhlc(
    pairAddress: string,
    opts: {
      timeframe?: "minute" | "hour" | "day";
      aggregate?: number;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }>
  > {
    const timeframe = opts.timeframe ?? "hour";
    const aggregate = opts.aggregate ?? 1;
    const limit = Math.min(opts.limit ?? 168, 1000);
    const cacheKey = `gt_ohlc_${pairAddress.toLowerCase()}_${timeframe}_${aggregate}_${limit}`;
    const cached = this.cache.get<any[]>(cacheKey);
    if (cached) return cached;

    let response: { data: any };
    try {
      response = await this.geckoOnchainGet(
        `/networks/robinhood/pools/${pairAddress}/ohlcv/${timeframe}`,
        {
          aggregate,
          limit,
          currency: "usd",
          token: "base",
        },
      );
    } catch (error) {
      const stale = this.cache.get<any[]>(`${cacheKey}_stale`);
      if (stale) return stale;
      throw error;
    }

    const list: number[][] = response.data?.data?.attributes?.ohlcv_list ?? [];
    // GT returns newest-first; lightweight-charts wants unique ascending times
    const mapped = this.normalizeOhlcCandles(
      list.map((row) => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      })),
    );

    this.cache.set(cacheKey, mapped, 120);
    this.cache.set(`${cacheKey}_stale`, mapped, 86400);
    return mapped;
  }

  /**
   * GeckoTerminal on-chain data (Robinhood pools) with fallbacks:
   *  - demo key: public GeckoTerminal first (~30 req/min per IP), CoinGecko on-chain only on failure,
   *    so the shared monthly demo quota (also used for the ETH price) isn't spent on charts;
   *  - pro key (`pro-api` URL): CoinGecko on-chain first (500 req/min), GeckoTerminal as fallback.
   * Callers additionally fall back to the last good response (`<cacheKey>_stale`, 24h).
   */
  private async geckoOnchainGet(
    path: string,
    params: Record<string, unknown>,
  ): Promise<{ data: any }> {
    type Source = {
      name: string;
      url: string;
      headers: Record<string, string>;
    };
    const geckoTerminal: Source = {
      name: "GeckoTerminal",
      url: `https://api.geckoterminal.com/api/v2${path}`,
      headers: {},
    };
    const sources: Source[] = [geckoTerminal];
    if (this.coinGeckoApiKey && this.coinGeckoApiUrl) {
      const isPro = this.coinGeckoApiUrl.includes("pro-api");
      const coinGecko: Source = {
        name: "CoinGecko onchain",
        url: `${this.coinGeckoApiUrl}/v3/onchain${path}`,
        headers: {
          [isPro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]:
            this.coinGeckoApiKey,
        },
      };
      if (isPro) sources.unshift(coinGecko);
      else sources.push(coinGecko);
    }

    let lastError: unknown;
    for (const source of sources) {
      try {
        return await axios.get(source.url, {
          params,
          headers: { Accept: "application/json", ...source.headers },
          timeout: 15000,
        });
      } catch (error) {
        lastError = error;
        const status = (error as any)?.response?.status;
        // 404 = pool not indexed; the other source uses the same index, so don't retry.
        if (status === 404) throw error;
        this.logger.warn(
          `${source.name} ${path} failed (${status ?? (error as Error).message}), trying next source`,
        );
      }
    }
    throw lastError;
  }

  /** Most liquid Robinhood pool for a token per GeckoTerminal — fallback when DexScreener has no pair. */
  async findGeckoTerminalTopPool(tokenAddress: string): Promise<string | null> {
    const token = tokenAddress.toLowerCase();
    const cacheKey = `gt_top_pool_${token}`;
    const cached = this.cache.get<string | null>(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const response = await this.geckoOnchainGet(
        `/networks/robinhood/tokens/${token}/pools`,
        { page: 1 },
      );
      const pools: any[] = Array.isArray(response.data?.data)
        ? response.data.data
        : [];
      const best =
        pools.sort(
          (a, b) =>
            Number(b.attributes?.reserve_in_usd ?? 0) -
            Number(a.attributes?.reserve_in_usd ?? 0),
        )[0] ?? null;
      const address: string | null = best?.attributes?.address ?? null;
      this.cache.set(cacheKey, address, address ? 3600 : 300);
      return address;
    } catch (error) {
      this.logger.warn(
        `GeckoTerminal pool lookup failed for ${token}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Recent pool trades from GeckoTerminal (newest first).
   * Prices/amounts are for `tokenAddress` (the meme), not the quote.
   */
  async getGeckoTerminalTrades(
    pairAddress: string,
    tokenAddress: string,
    limit = 30,
  ): Promise<
    Array<{
      tx_hash: string;
      kind: "buy" | "sell";
      price_usd: number | null;
      amount_token: number | null;
      volume_usd: number | null;
      timestamp: string | null;
      trader: string | null;
      block_number: number | null;
    }>
  > {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const token = tokenAddress.toLowerCase();
    const cacheKey = `gt_trades_${pairAddress.toLowerCase()}_${token}_${safeLimit}`;
    const cached = this.cache.get<any[]>(cacheKey);
    if (cached) return cached;

    let response: { data: any };
    try {
      response = await this.geckoOnchainGet(
        `/networks/robinhood/pools/${pairAddress}/trades`,
        {
          trade_volume_in_usd_greater_than: 0,
        },
      );
    } catch (error) {
      const stale = this.cache.get<any[]>(`${cacheKey}_stale`);
      if (stale) return stale;
      throw error;
    }

    const rows: any[] = Array.isArray(response.data?.data)
      ? response.data.data
      : [];
    const mapped = rows.slice(0, safeLimit).map((row) => {
      const a = row.attributes ?? {};
      const fromAddr = (a.from_token_address || "").toLowerCase();
      const tokenIsFrom = fromAddr === token;
      const priceUsd = tokenIsFrom
        ? a.price_from_in_usd != null
          ? Number(a.price_from_in_usd)
          : null
        : a.price_to_in_usd != null
          ? Number(a.price_to_in_usd)
          : null;
      const amountRaw = tokenIsFrom ? a.from_token_amount : a.to_token_amount;
      // GT kind is pool-relative; derive from whether trader sent or received the meme
      const kind: "buy" | "sell" = tokenIsFrom ? "sell" : "buy";

      return {
        tx_hash: a.tx_hash ?? row.id ?? "",
        kind,
        price_usd: priceUsd,
        amount_token: amountRaw != null ? Number(amountRaw) : null,
        volume_usd: a.volume_in_usd != null ? Number(a.volume_in_usd) : null,
        timestamp: a.block_timestamp ?? null,
        trader: a.tx_from_address ?? null,
        block_number: a.block_number != null ? Number(a.block_number) : null,
      };
    });

    this.cache.set(cacheKey, mapped, 60); // GT public API is ~10 req/min per IP — keep trade polling cheap
    this.cache.set(`${cacheKey}_stale`, mapped, 86400);
    return mapped;
  }

  /** Sort ascending by time and merge duplicate timestamps (lightweight-charts requires unique asc times). */
  private normalizeOhlcCandles(
    candles: Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }>,
  ) {
    const sorted = candles
      .filter((c) => c.time && !Number.isNaN(Number(c.open)))
      .map((c) => ({
        time: Math.floor(Number(c.time)),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }))
      .sort((a, b) => a.time - b.time);

    const out: typeof sorted = [];
    for (const candle of sorted) {
      const prev = out[out.length - 1];
      if (prev && prev.time === candle.time) {
        prev.high = Math.max(prev.high, candle.high);
        prev.low = Math.min(prev.low, candle.low);
        prev.close = candle.close;
      } else {
        out.push({ ...candle });
      }
    }
    return out;
  }
}
