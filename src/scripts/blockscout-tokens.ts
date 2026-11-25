/**
 * Token list of Robinhood Chain from the Blockscout PRO API (`/tokens`, sorted by market cap).
 * Shared by the swap-pool scripts. Costs one API call (20 credits) per page of 50 tokens.
 */
export interface BlockscoutToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  holders: number;
  marketCapUsd: number;
  volume24hUsd: number;
  priceUsd: number;
  totalSupply: string | null;
  iconUrl: string | null;
  reputation: string | null;
  /** Robinhood scaled-UI tokens (stocks) report a multiplier; plain tokens null. */
  uiMultiplier: string | null;
}

interface RawToken {
  address_hash: string;
  name: string | null;
  symbol: string | null;
  decimals: string | null;
  holders_count: string | null;
  circulating_market_cap: string | null;
  volume_24h: string | null;
  exchange_rate: string | null;
  total_supply: string | null;
  icon_url: string | null;
  reputation: string | null;
  ui_multiplier: string | null;
}

/** "9.84088E-7" → "0.000000984088"; any other string is returned unchanged (exact, no float math). */
export function plainDecimal(v: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(v);
  if (!m) return v;
  const [, sign, int, frac = '', expRaw] = m;
  const digits = int + frac;
  const point = int.length + Number(expRaw);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`.replace(/\.?0+$/, '');
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

const num = (v: string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toToken(t: RawToken): BlockscoutToken {
  return {
    address: t.address_hash.toLowerCase(),
    name: t.name ?? '',
    symbol: t.symbol ?? '',
    decimals: t.decimals === null ? null : Number(t.decimals),
    holders: num(t.holders_count),
    marketCapUsd: num(t.circulating_market_cap),
    volume24hUsd: num(t.volume_24h),
    priceUsd: num(t.exchange_rate),
    totalSupply: t.total_supply,
    iconUrl: t.icon_url,
    reputation: t.reputation,
    uiMultiplier: t.ui_multiplier,
  };
}

/** One token by address (null: Blockscout does not know it). 20 credits. */
export async function fetchBlockscoutToken(
  apiKey: string,
  address: string,
  chainId = 4663
): Promise<BlockscoutToken | null> {
  const res = await fetch(`https://api.blockscout.com/${chainId}/api/v2/tokens/${address}?apikey=${apiKey}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Blockscout token ${address}: HTTP ${res.status}`);
  return toToken((await res.json()) as RawToken);
}

/** First page of tokens whose name or symbol matches `query` (to spot copies of a symbol). 20 credits. */
export async function searchBlockscoutTokens(
  apiKey: string,
  query: string,
  chainId = 4663
): Promise<BlockscoutToken[]> {
  const q = new URLSearchParams({ q: query, apikey: apiKey });
  const res = await fetch(`https://api.blockscout.com/${chainId}/api/v2/tokens?${q}`);
  if (!res.ok) throw new Error(`Blockscout token search: HTTP ${res.status}`);
  return ((await res.json()) as { items: RawToken[] }).items.map(toToken);
}

/** Token standards Blockscout lists on Robinhood Chain. Robinhood's stock tokens are ERC-8056, not ERC-20. */
export const TOKEN_TYPES = ['ERC-20', 'ERC-8056'] as const;

/**
 * Up to `max` tokens of each of `types` (default every standard, all tokens), best market cap first.
 * `onPage` reports progress.
 */
export async function fetchBlockscoutTokens(
  apiKey: string,
  opts: {
    chainId?: number;
    max?: number;
    maxPages?: number;
    types?: readonly string[];
    onPage?: (page: number, total: number) => void;
  } = {}
): Promise<BlockscoutToken[]> {
  const all: BlockscoutToken[] = [];
  const seen = new Set<string>();
  for (const type of opts.types ?? TOKEN_TYPES) {
    for (const t of await fetchType(apiKey, type, opts)) {
      if (seen.has(t.address)) continue;
      seen.add(t.address);
      all.push(t);
    }
  }
  all.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  return Number.isFinite(opts.max ?? Number.POSITIVE_INFINITY) && opts.max ? all.slice(0, opts.max) : all;
}

async function fetchType(
  apiKey: string,
  type: string,
  opts: { chainId?: number; max?: number; maxPages?: number; onPage?: (page: number, total: number) => void }
): Promise<BlockscoutToken[]> {
  const chainId = opts.chainId ?? 4663;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const maxPages = opts.maxPages ?? 400;
  const out: BlockscoutToken[] = [];
  let next: Record<string, string> | null = {};
  let page = 0;
  while (next && out.length < max && page < maxPages) {
    const q = new URLSearchParams({ type, apikey: apiKey, ...next });
    const res = await fetch(`https://api.blockscout.com/${chainId}/api/v2/tokens?${q}`);
    if (!res.ok) throw new Error(`Blockscout tokens: HTTP ${res.status}`);
    const body = (await res.json()) as { items: RawToken[]; next_page_params: Record<string, unknown> | null };
    for (const t of body.items) out.push(toToken(t));
    page++;
    opts.onPage?.(page, out.length);
    // Blockscout's own cursor holds small fiat values as "9.84088E-7" and then rejects that form with
    // 422, so cursor values are sent back as plain decimals (null as empty, booleans as text).
    next = body.next_page_params
      ? Object.fromEntries(
          Object.entries(body.next_page_params).map(([k, v]) => [k, v === null ? '' : plainDecimal(String(v))])
        )
      : null;
  }
  return Number.isFinite(max) ? out.slice(0, max) : out;
}
