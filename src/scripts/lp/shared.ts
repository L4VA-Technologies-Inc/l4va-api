/**
 * Shared helpers for the Uniswap LP API scripts on Robinhood Chain.
 *
 * The LP API is a transaction-building service: we send position parameters,
 * it returns unsigned calldata. It never holds keys and never broadcasts —
 * signing and broadcasting happen here.
 *
 * Docs: https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api
 */

import { defineChain, isAddress } from 'viem';

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * NOTE: the LP API host is deliberately different from the swap Trading API
 * (`https://trade-api.gateway.uniswap.org/v1`). Keep it as one constant.
 */
export const LP_API_BASE_URL = 'https://liquidity.api.uniswap.org';

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

/** Native ETH is addressed as the zero address throughout the LP API. */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export function apiKey(): string {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) throw new Error('UNISWAP_API_KEY not set — get one at https://developers.uniswap.org/dashboard');
  return key;
}

export async function lpFetch<T = any>(path: string, body: object): Promise<T> {
  const res = await fetch(`${LP_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    // Connect-protocol errors carry { code, message } — not a top-level `error`.
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.code || parsed?.message) detail = `${parsed.code}: ${parsed.message}`;
    } catch {
      /* keep raw text */
    }
    throw new Error(`${path} failed (${res.status}) — ${detail}`);
  }

  return res.json() as Promise<T>;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Never edit LP API calldata — modifying it can revert or lose funds. Validate
 * shape only.
 */
export function validateLpTransaction(tx: any, label = 'transaction'): void {
  if (!tx) throw new Error(`${label}: missing`);
  if (!tx.data || tx.data === '' || tx.data === '0x') throw new Error(`${label}: empty data`);
  if (!tx.to || !isAddress(tx.to)) throw new Error(`${label}: invalid "to"`);
  if (!tx.from || !isAddress(tx.from)) throw new Error(`${label}: invalid "from"`);
  if (tx.maxFeePerGas && tx.gasPrice) {
    throw new Error(`${label}: cannot set both maxFeePerGas and gasPrice`);
  }
}

export function requireAddress(value: string | undefined, name: string): `0x${string}` {
  if (!value || !isAddress(value)) throw new Error(`${name} must be a valid address (got: ${value})`);
  return value as `0x${string}`;
}

// ── Price math ───────────────────────────────────────────────────────────────

/** Integer square root (Newton's method) — avoids float precision loss. */
export function bigIntSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('bigIntSqrt: negative');
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

const Q96 = 2n ** 96n;

/**
 * sqrtRatioX96 for a brand-new pool, from an exact price ratio.
 *
 * Uniswap prices are token1 per token0 in RAW units, and token order is by
 * ascending address — so work out which side is token0 before calling this.
 * Native ETH (the zero address) always sorts first.
 *
 * @param token1PerToken0Num  numerator of token1-per-token0, in raw units
 * @param token1PerToken0Den  denominator, in raw units
 */
export function sqrtRatioX96(token1PerToken0Num: bigint, token1PerToken0Den: bigint): string {
  if (token1PerToken0Den === 0n) throw new Error('sqrtRatioX96: zero denominator');
  // sqrt(price) * 2^96  ==  sqrt(price * 2^192)
  const priceX192 = (token1PerToken0Num * Q96 * Q96) / token1PerToken0Den;
  return bigIntSqrt(priceX192).toString();
}

/** Sort a token pair the way Uniswap does: ascending address. */
export function sortTokens(a: string, b: string): [`0x${string}`, `0x${string}`] {
  return (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]) as [`0x${string}`, `0x${string}`];
}

// ── Misc ─────────────────────────────────────────────────────────────────────

export function fmtEth(wei: bigint): string {
  return `${(Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH`;
}

export function fmtToken(raw: bigint, decimals = 18, symbol = 'L4VA'): string {
  return `${(Number(raw) / 10 ** decimals).toLocaleString('en-US', {
    maximumFractionDigits: 4,
  })} ${symbol}`;
}

// ── Contract reads ───────────────────────────────────────────────────────────

/**
 * Thin wrapper around `readContract`.
 *
 * viem 2.55's `ReadContractParameters` union is unsatisfiable under this
 * project's tsconfig (it demands `authorizationList`, which is not a real
 * requirement for a read). `taptools.service.ts` works around the same issue by
 * typing the client as `any` at the call boundary; this keeps that workaround
 * in one documented place instead of scattering casts through the scripts.
 */
export async function readContract<T>(
  client: any,
  params: { address: `0x${string}`; abi: unknown; functionName: string; args?: unknown[] }
): Promise<T> {
  return client.readContract(params) as Promise<T>;
}
