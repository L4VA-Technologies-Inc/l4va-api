export const BPS = 10_000n;

/** `expected × (1 − bps)`, rounded down. */
export function applySlippage(expected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer in [0, 10000]; got ${slippageBps}`);
  }
  return (expected * (BPS - BigInt(slippageBps))) / BPS;
}

export function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Uniform random integer in [min, max]. */
export function randomInt(min: number, max: number, rng: () => number = Math.random): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Size of one buy: a random share in [minChunkBps, 10000] of `available`, at least 1 unit. */
export function randomConvertAmount(available: bigint, minChunkBps: number, rng: () => number = Math.random): bigint {
  if (available === 0n) return 0n;
  const share = BigInt(randomInt(minChunkBps, Number(BPS), rng));
  return maxBigint((available * share) / BPS, 1n);
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Errors worth retrying BEFORE a transaction is broadcast (RPC hiccups, rate
 * limits, nonce races). On-chain reverts are never retried.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/revert|ContractFunctionRevertedError|execution reverted/i.test(msg)) return false;
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|429|502|503|504|rate limit|nonce too low|replacement transaction underpriced|already known/i.test(
    msg
  );
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Exponential backoff with jitter; rethrows the last error or any non-retryable one. */
export async function withRetries<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === opts.retries || !opts.isRetryable(err)) throw err;
      const delay = Math.min(opts.baseDelayMs * 2 ** attempt, 30_000) + Math.floor(Math.random() * 100);
      await sleep(delay);
    }
  }
  throw lastErr;
}
