import { Logger } from '@nestjs/common';
import { fallback, http, type Transport } from 'viem';

const logger = new Logger('EvmTransport');
const loggedSummaries = new Set<string>();

/** Anything with a ConfigService-like `get` (ConfigService, or a plain env map in scripts/config loaders). */
type ConfigLike = { get<T = string>(key: string): T | undefined };

const ALCHEMY_NETWORK_BY_CHAIN_ID: Record<number, string> = {
  4663: 'robinhood-mainnet',
  46630: 'robinhood-testnet',
};

const normalize = (url: string): string => url.trim().replace(/\/$/, '');

/**
 * Ordered, de-duplicated Robinhood RPC URLs for the configured chain:
 *  1. `primary` (defaults to EVM_RPC_URL),
 *  2. EVM_RPC_FALLBACK_URLS (comma-separated, optional),
 *  3. Alchemy for the SAME chain: ROBINHOOD_ALCHEMY_RPC_URL, or derived from ALCHEMY_API_KEY + EVM_CHAIN_ID.
 *
 * Alchemy is only derived from the chain id (4663 / 46630), never guessed, so a testnet deployment can't
 * silently fall back to a mainnet node. An explicit ROBINHOOD_ALCHEMY_RPC_URL is trusted as configured.
 */
export function resolveEvmRpcUrls(config: ConfigLike, primary?: string | null): string[] {
  const urls: string[] = [];
  const add = (url?: string | null) => {
    if (!url?.trim()) return;
    const value = normalize(url);
    if (!urls.includes(value)) urls.push(value);
  };

  add(primary ?? config.get<string>('EVM_RPC_URL'));
  for (const url of (config.get<string>('EVM_RPC_FALLBACK_URLS') ?? '').split(',')) add(url);

  const explicitAlchemy = config.get<string>('ROBINHOOD_ALCHEMY_RPC_URL');
  if (explicitAlchemy?.trim()) {
    add(explicitAlchemy);
  } else {
    const apiKey = config.get<string>('ALCHEMY_API_KEY')?.trim();
    const network = ALCHEMY_NETWORK_BY_CHAIN_ID[Number(config.get<string | number>('EVM_CHAIN_ID') || 0)];
    if (apiKey && network) add(`https://${network}.g.alchemy.com/v2/${apiKey}`);
  }

  return urls;
}

/**
 * Transport for WALLET clients (sending transactions): the primary RPC only, never a fallback.
 * If the primary accepted a raw tx but timed out, a fallback node would answer "already known" /
 * "nonce too low" and the caller would treat a mined tx as failed (and maybe resend with a new nonce).
 * Reads — including receipts and nonces via the public client — still use `buildEvmTransport`.
 */
export function buildEvmWriteTransport(rpcUrl: string | null | undefined): Transport {
  if (!rpcUrl?.trim()) throw new Error('EVM_RPC_URL is not configured');
  return http(normalize(rpcUrl));
}

/**
 * viem transport over every configured RPC: a single `http` when only one URL exists, otherwise
 * `fallback` (in order — the primary keeps all traffic while healthy). viem only moves to the next
 * node on transport-level failures (timeouts, 429, 5xx); deterministic errors such as a contract
 * revert are thrown straight away, so reads behave exactly as with one node.
 */
export function buildEvmTransport(config: ConfigLike, primary?: string | null): Transport {
  const urls = resolveEvmRpcUrls(config, primary);
  if (urls.length === 0) throw new Error('EVM_RPC_URL is not configured');
  if (urls.length === 1) return http(urls[0], { retryCount: 2 });

  const summary = urls.map(u => new URL(u).host).join(' → ');
  if (!loggedSummaries.has(summary)) {
    loggedSummaries.add(summary);
    logger.log(`EVM RPC with ${urls.length - 1} fallback(s): ${summary}`);
  }
  return fallback(
    urls.map(url => http(url, { retryCount: 1, timeout: 10_000 })),
    { rank: false, retryCount: 1 }
  );
}
