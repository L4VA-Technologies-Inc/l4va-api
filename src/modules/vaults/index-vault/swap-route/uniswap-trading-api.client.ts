import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Address } from 'viem';

import type { TradingApiQuoteResponse } from './multi-path-route';

/** The Trading API could not answer (outage, rate limit, auth). Says nothing about the token. */
export class TradingApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradingApiUnavailableError';
  }
}

/** The Trading API answered that it has no route for the pair. */
export interface TradingApiNoRoute {
  noRoute: true;
  detail: string;
}

const BASE_URL = 'https://trade-api.gateway.uniswap.org/v1';
/** Must match the router the adapter calls (`x-universal-router-version`). */
const UNIVERSAL_ROUTER_VERSION = '2.1.1';
const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
/** Uniswap allows ~10 req/s per endpoint; stay well under it across this process. */
const MIN_INTERVAL_MS = 200;

/**
 * Minimal `/quote` client for index-vault routing.
 *
 * Every request asks only for what the vault's swap adapter can execute:
 * Uniswap v3 and v4 pools, v4 without hooks. Docs:
 * https://developers.uniswap.org/docs/api-reference/aggregator_quote and
 * https://developers.uniswap.org/docs/trading/swapping-api/concepts/swap-routing
 */
@Injectable()
export class UniswapTradingApiClient {
  private readonly logger = new Logger(UniswapTradingApiClient.name);
  private readonly apiKey: string | null;
  private readonly chainId: number;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(configService: ConfigService) {
    this.apiKey = configService.get<string>('UNISWAP_API_KEY') || null;
    this.chainId = Number(configService.get<string>('EVM_CHAIN_ID') ?? 4663);
  }

  get enabled(): boolean {
    return this.apiKey !== null;
  }

  /**
   * @param swapper The address that will execute the swap (the vault's swap adapter).
   * @returns The quote, or `{ noRoute }` when Uniswap has no route for the pair.
   * @throws TradingApiUnavailableError when no answer could be obtained.
   */
  async quoteExactInput(
    tokenIn: Address,
    tokenOut: Address,
    amount: bigint,
    swapper: Address
  ): Promise<TradingApiQuoteResponse | TradingApiNoRoute> {
    if (!this.apiKey) throw new TradingApiUnavailableError('UNISWAP_API_KEY is not configured');
    const body = JSON.stringify({
      tokenIn,
      tokenOut,
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      amount: amount.toString(),
      type: 'EXACT_INPUT',
      swapper,
      protocols: ['V3', 'V4'],
      hooksOptions: 'V4_NO_HOOKS',
      routingPreference: 'BEST_PRICE',
    });

    let lastError = 'no attempt made';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}/quote`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'x-universal-router-version': UNIVERSAL_ROUTER_VERSION,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        lastError = `request failed: ${(err as Error).message}`;
        await this.backoff(attempt);
        continue;
      }

      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        // Non-JSON body (gateway error page); handled by status below.
      }
      const detail = String(json.detail ?? json.errorCode ?? text.slice(0, 200));

      if (res.ok) return json as TradingApiQuoteResponse;
      // A malformed request is our bug, never a reason to call a token untradable.
      if (res.status === 400 && json.errorCode === 'RequestValidationError') {
        throw new TradingApiUnavailableError(`Trading API rejected the request: ${detail}`);
      }
      // 404 = "No quotes available"; other 400s = the pair/amount is not quotable (e.g. unknown token).
      if (res.status === 404 || res.status === 400) return { noRoute: true, detail };
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}: ${detail}`;
        await this.backoff(attempt);
        continue;
      }
      // 401/403 and anything unexpected: configuration problem, not a token problem.
      throw new TradingApiUnavailableError(`Trading API HTTP ${res.status}: ${detail}`);
    }
    this.logger.warn(`Trading API quote ${tokenIn}→${tokenOut} unavailable: ${lastError}`);
    throw new TradingApiUnavailableError(`Trading API unavailable: ${lastError}`);
  }

  /** Serialises requests with a minimum gap, so bursts (portfolio valuation) stay under the rate limit. */
  private throttle(): Promise<void> {
    const next = this.queue.then(async () => {
      const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async backoff(attempt: number): Promise<void> {
    if (attempt >= MAX_ATTEMPTS) return;
    const ms = Math.min(250 * 2 ** attempt + Math.random() * 150, 3_000);
    await new Promise(r => setTimeout(r, ms));
  }
}
