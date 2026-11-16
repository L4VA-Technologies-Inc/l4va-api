/**
 * Retries + endpoint fallback for external HTTP APIs (Blockscout, DexScreener, …),
 * the HTTP-API counterpart of the viem `fallback` transport used for RPC.
 *
 * - Transient failures (network error, timeout, 408/425/429/5xx) are retried with
 *   exponential backoff + jitter.
 * - Other 4xx (e.g. a Cloudflare 403 challenge) are NOT retried — they will not heal
 *   in seconds. Callers move to the next base URL, and can put the failing base on
 *   cooldown so every cron tick does not hammer (and log) a blocked endpoint.
 */

/** Anything with a ConfigService-like `get`. */
type ConfigLike = { get<T = string>(key: string): T | undefined };

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? ` body=${body.slice(0, 160)}` : ''}`);
  }
}

export interface RetryOptions {
  /** Extra attempts after the first one. Default 3. */
  retries?: number;
  /** Per-attempt timeout. Default 15s. */
  timeoutMs?: number;
  /** First backoff delay; doubles each attempt. Default 500ms. */
  baseDelayMs?: number;
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function isRetryableHttpError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return RETRYABLE_STATUS.has(err.status);
  return true; // network error / abort (timeout) / DNS
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** GET a JSON document, retrying transient failures. Throws HttpStatusError on a non-retryable status. */
export async function fetchJsonWithRetry<T = unknown>(url: string, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseDelayMs = options.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new HttpStatusError(response.status, await response.text().catch(() => ''), url);
      }
      return (await response.json()) as T;
    } catch (err) {
      lastError = err;
      if (!isRetryableHttpError(err) || attempt === retries) break;
      await sleep(baseDelayMs * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Base-URL cooldown (process-local)

const cooldownUntil = new Map<string, number>();

/** Default cooldown for a base that answered a hard block (403 Cloudflare challenge etc.). */
export const BLOCKED_BASE_COOLDOWN_MS = 15 * 60_000;

export function markBaseDown(base: string, ms = BLOCKED_BASE_COOLDOWN_MS): void {
  cooldownUntil.set(base, Date.now() + ms);
}

export function isBaseDown(base: string): boolean {
  const until = cooldownUntil.get(base);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooldownUntil.delete(base);
    return false;
  }
  return true;
}

/** A hard block worth a cooldown: 401/403 (auth / Cloudflare challenge). */
export function isBlockedHttpError(err: unknown): boolean {
  return err instanceof HttpStatusError && (err.status === 401 || err.status === 403);
}

// ---------------------------------------------------------------------------
// Blockscout holders API bases

const BLOCKSCOUT_PRO_MAINNET = 'https://api.blockscout.com/4663/api/v2';
const BLOCKSCOUT_EXPLORER_MAINNET = 'https://robinhoodchain.blockscout.com/api/v2';
const BLOCKSCOUT_EXPLORER_TESTNET = 'https://explorer.testnet.chain.robinhood.com/api/v2';

/**
 * Ordered Blockscout v2 bases to try for the configured chain:
 *  1. ROBINHOOD_HOLDERS_API_BASE_URL (explicit; may be comma-separated),
 *  2. mainnet: the PRO API (only with BLOCKSCOUT_API_KEY — the explorer domain sits behind
 *     a Cloudflare challenge that rejects server requests), then the explorer domain,
 *  3. testnet: the testnet explorer.
 */
export function resolveBlockscoutBases(config: ConfigLike, chainId?: number | string | null): string[] {
  const bases: string[] = [];
  const add = (url?: string | null): void => {
    const value = url?.trim().replace(/\/$/, '');
    if (value && !bases.includes(value)) bases.push(value);
  };

  for (const url of (config.get<string>('ROBINHOOD_HOLDERS_API_BASE_URL') ?? '').split(',')) add(url);

  const id = Number(chainId ?? config.get<string | number>('EVM_CHAIN_ID') ?? 0);
  const rpcUrl = (config.get<string>('ROBINHOOD_RPC_URL') ?? '').toLowerCase();
  const testnet = id === 46630 || (!id && rpcUrl.includes('testnet'));

  if (testnet) {
    add(BLOCKSCOUT_EXPLORER_TESTNET);
  } else {
    if (config.get<string>('BLOCKSCOUT_API_KEY')?.trim()) add(BLOCKSCOUT_PRO_MAINNET);
    add(BLOCKSCOUT_EXPLORER_MAINNET);
  }
  return bases;
}

/** Appends the Blockscout PRO key when the URL targets api.blockscout.com. */
export function withBlockscoutKey(url: URL, config: ConfigLike): URL {
  const key = config.get<string>('BLOCKSCOUT_API_KEY')?.trim();
  if (key && url.hostname === 'api.blockscout.com') url.searchParams.set('apikey', key);
  return url;
}
