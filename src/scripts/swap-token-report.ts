/**
 * Token risk and liquidity report for the swap-pool allowlist. Run by hand, read-only.
 *
 * Takes (almost) every token Blockscout lists on Robinhood Chain and adds, per token:
 *   - category: RWA (Robinhood stock token / Ondo / aStock), stablecoin, established, meme,
 *     small-cap, impersonator (copy of a real token), dead;
 *   - risk level and the reasons behind it;
 *   - liquidity: the round-trip probe from `swap-pool-sync.ts` where the token was probed
 *     (status, largest passing size, loss per size, allowlisted pools), otherwise a proxy
 *     from 24h volume and market cap, marked "not probed".
 *
 * Output (OUT_DIR): tokens.csv (open in Sheets/Excel), tokens.json, summary.md.
 * The classification is heuristic (names, market data, probe results): use it to decide what to
 * review, not as a verdict. Nothing is signed or sent.
 *
 * Usage (from l4va-api):
 *   REPORTS=stage=pool-sync-stage/report.json,prod=pool-sync-mainnet/report.json \
 *   MAX_TOKENS=0 \                      # 0 = every token Blockscout lists (≈20 credits per 50 tokens)
 *   CACHE=blockscout-tokens.json \      # optional: reuse a saved token list instead of calling Blockscout
 *   OUT_DIR=token-report-2026-11-22 \
 *   npx ts-node -r tsconfig-paths/register src/scripts/swap-token-report.ts
 *
 * Env from ENV_FILE (default .env): BLOCKSCOUT_API_KEY.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { config } from 'dotenv';

import { fetchBlockscoutTokens, type BlockscoutToken } from './blockscout-tokens';

const L4VA_TOKEN = '0x0c020bef365d7001611ef1cecd6084cdd6b73683';
const STABLE_SYMBOLS = new Set([
  'USDG',
  'USDC',
  'USDT',
  'DAI',
  'USDS',
  'PYUSD',
  'EURC',
  'FDUSD',
  'USDE',
  'USD1',
  'GHO',
]);
const MEME_WORDS =
  /\b(cat|dog|doge|inu|shib|pepe|frog|moon|baby|elon|trump|wojak|chad|meme|pump|rug|ape|bonk|wif|hood(rat)?|rocket|lambo|degen|giga|based|fart|poop|tard|kitty|puppy|king|goat|sigma|cope|wagmi|ngmi|gme|pnut)\b/i;

type Category =
  | 'RWA - Robinhood stock token'
  | 'RWA - Ondo tokenized'
  | 'RWA - other (aStock/Anchored)'
  | 'Stablecoin'
  | 'Established'
  | 'L4VA'
  | 'Meme'
  | 'Small-cap (unclassified)'
  | 'Impersonator'
  | 'Dead';

type RiskLevel = 'Low' | 'Medium' | 'High' | 'Very high' | 'Avoid';
type LiquidityTier = 'Deep' | 'Good' | 'Thin' | 'Very thin' | 'No route' | 'Illiquid' | 'Not probed';

interface ProbeToken {
  address: string;
  symbol: string;
  status: 'ok' | 'partial' | 'no_route' | 'illiquid' | string;
  maxPassingEth: string | null;
  lossBps: Record<string, number | null>;
  failure?: string;
}
interface ProbePool {
  id: string;
  token0: string;
  token1: string;
  allowed?: boolean;
  onPassingRoute?: boolean;
}
interface SyncReport {
  stack?: string;
  settings?: { maxRoundTripLossBps?: number };
  tokens: ProbeToken[];
  pools: ProbePool[];
}

interface Row {
  address: string;
  symbol: string;
  name: string;
  category: Category;
  risk: RiskLevel;
  riskScore: number;
  reasons: string[];
  liquidity: LiquidityTier;
  marketCapUsd: number;
  volume24hUsd: number;
  holders: number;
  priceUsd: number;
  /** Per report label: probe result and pool state. */
  probes: Record<string, ProbeSummary | null>;
}
interface ProbeSummary {
  status: string;
  maxPassingEth: string | null;
  lossAt001: number | null;
  lossAt01: number | null;
  lossAt1: number | null;
  poolsAllowed: number;
  poolsToAdd: number;
}

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};
const lower = (s: string): string => s.toLowerCase();
const isRobinhoodIcon = (t: BlockscoutToken): boolean => (t.iconUrl ?? '').includes('cdn.robinhood.com');

function category(t: BlockscoutToken, canonical: Map<string, BlockscoutToken>): { cat: Category; why?: string } {
  const name = t.name;
  const sym = t.symbol.toUpperCase();
  if (t.address === L4VA_TOKEN) return { cat: 'L4VA' };

  const claimsRobinhood = /robinhood token/i.test(name);
  const claimsOndo = /ondo tokenized/i.test(name);
  const claimsAnchored = /astock|anchored tokenized/i.test(name);
  const canon = canonical.get(sym);
  // A second token with the same symbol and a fraction of the market cap is a copy.
  const isCopy = !!canon && canon.address !== t.address && canon.marketCapUsd > Math.max(t.marketCapUsd, 1) * 20;

  if (claimsRobinhood || claimsOndo || claimsAnchored) {
    if (claimsRobinhood && !isRobinhoodIcon(t))
      return { cat: 'Impersonator', why: 'named "Robinhood Token" without the Robinhood logo' };
    if (isCopy) return { cat: 'Impersonator', why: `same symbol as ${canon!.address} with a far larger market cap` };
    if (t.marketCapUsd === 0 && t.holders < 50)
      return { cat: 'Impersonator', why: 'RWA-style name, no market cap and few holders' };
    if (claimsRobinhood) return { cat: 'RWA - Robinhood stock token' };
    if (claimsOndo) return { cat: 'RWA - Ondo tokenized' };
    return { cat: 'RWA - other (aStock/Anchored)' };
  }
  if (isCopy && canon!.marketCapUsd > 1_000_000) {
    return {
      cat: 'Impersonator',
      why: `same symbol as ${canon!.address} (${Math.round(canon!.marketCapUsd)} USD market cap)`,
    };
  }
  if (STABLE_SYMBOLS.has(sym) && t.priceUsd > 0.9 && t.priceUsd < 1.1) return { cat: 'Stablecoin' };
  if (t.marketCapUsd === 0 && t.volume24hUsd === 0 && t.holders < 10) return { cat: 'Dead' };
  if (t.marketCapUsd >= 20_000_000 && t.holders >= 1000) return { cat: 'Established' };
  if (MEME_WORDS.test(name) || MEME_WORDS.test(t.symbol)) return { cat: 'Meme' };
  return { cat: 'Small-cap (unclassified)' };
}

function summarize(
  address: string,
  report: SyncReport | undefined,
  poolsBy: Map<string, ProbePool[]>
): ProbeSummary | null {
  if (!report) return null;
  const probe = report.tokens.find(t => lower(t.address) === address);
  const pools = poolsBy.get(address) ?? [];
  if (!probe && pools.length === 0) return null;
  const loss = (k: string): number | null => (probe?.lossBps && k in probe.lossBps ? probe.lossBps[k] : null);
  return {
    status: probe?.status ?? 'not probed',
    maxPassingEth: probe?.maxPassingEth ?? null,
    lossAt001: loss('0.01'),
    lossAt01: loss('0.1'),
    lossAt1: loss('1'),
    poolsAllowed: pools.filter(p => p.allowed).length,
    poolsToAdd: pools.filter(p => !p.allowed && p.onPassingRoute).length,
  };
}

function liquidityTier(t: BlockscoutToken, probes: Record<string, ProbeSummary | null>): LiquidityTier {
  // The most pessimistic probe wins (a token must work on every stack we report).
  const ps = Object.values(probes).filter((p): p is ProbeSummary => !!p && p.status !== 'not probed');
  if (ps.length === 0) return 'Not probed';
  const rank = (p: ProbeSummary): number => {
    if (p.status === 'no_route') return 0;
    if (p.status === 'illiquid') return 1;
    const eth = Number(p.maxPassingEth ?? 0);
    return eth >= 1 ? 5 : eth >= 0.3 ? 4 : eth >= 0.03 ? 3 : eth > 0 ? 2 : 1;
  };
  const worst = Math.min(...ps.map(rank));
  return (['No route', 'Illiquid', 'Very thin', 'Thin', 'Good', 'Deep'] as LiquidityTier[])[worst];
}

const BASE_RISK: Record<Category, number> = {
  Stablecoin: 5,
  Established: 15,
  L4VA: 20,
  'RWA - Robinhood stock token': 25,
  'RWA - Ondo tokenized': 35,
  'RWA - other (aStock/Anchored)': 40,
  'Small-cap (unclassified)': 45,
  Meme: 50,
  Dead: 90,
  Impersonator: 100,
};

function risk(
  t: BlockscoutToken,
  cat: Category,
  tier: LiquidityTier,
  probes: Record<string, ProbeSummary | null>,
  why?: string
): { score: number; level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let score = BASE_RISK[cat];
  if (cat === 'Impersonator') reasons.push(`copy / suspicious: ${why}`);
  if (cat === 'Dead') reasons.push('no market cap, volume or holders');
  if (cat.startsWith('RWA')) {
    reasons.push('issuer can pause transfers, block addresses or burn balances');
    if (cat === 'RWA - Ondo tokenized')
      reasons.push('liquidity usually only in hooked pools (our adapter rejects hooks)');
    reasons.push('price follows the stock market: stale while it is closed');
  }
  if (cat === 'Meme') reasons.push('meme: price and liquidity can disappear quickly');

  if (tier === 'No route') {
    score += 35;
    reasons.push('no Uniswap route');
  } else if (tier === 'Illiquid') {
    score += 25;
    reasons.push('round trip loses too much even at the smallest size');
  } else if (tier === 'Very thin') {
    score += 15;
    reasons.push('only works at tiny sizes (< 0.03 ETH)');
  } else if (tier === 'Thin') {
    score += 8;
    reasons.push('works only up to ~0.03-0.3 ETH');
  } else if (tier === 'Not probed') {
    if (t.volume24hUsd < 10_000) {
      score += 20;
      reasons.push(`24h volume ${Math.round(t.volume24hUsd)} USD, not probed`);
    } else if (t.volume24hUsd < 100_000) {
      score += 10;
      reasons.push('24h volume below 100k USD, not probed');
    }
  }
  for (const [label, p] of Object.entries(probes)) {
    if (p?.lossAt01 !== null && p?.lossAt01 !== undefined && p.lossAt01 > 500) {
      score += 10;
      reasons.push(`${label}: round trip loses ${(p.lossAt01 / 100).toFixed(1)}% at 0.1 ETH`);
    }
  }
  if (t.holders < 100) {
    score += 15;
    reasons.push(`only ${t.holders} holders`);
  } else if (t.holders < 1000) score += 5;
  if (t.marketCapUsd < 100_000) {
    score += 15;
    reasons.push('market cap below 100k USD');
  } else if (t.marketCapUsd < 1_000_000) score += 5;
  if (t.reputation && t.reputation !== 'ok') {
    score += 40;
    reasons.push(`Blockscout reputation: ${t.reputation}`);
  }

  score = Math.min(100, score);
  const level: RiskLevel =
    score < 25 ? 'Low' : score < 45 ? 'Medium' : score < 65 ? 'High' : score < 85 ? 'Very high' : 'Avoid';
  return { score, level, reasons };
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main(): Promise<void> {
  config({ path: process.env.ENV_FILE || '.env', quiet: true });
  const outDir = process.env.OUT_DIR || `token-report-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(outDir, { recursive: true });

  // ---- sync reports ---------------------------------------------------------
  const reports: Record<string, SyncReport> = {};
  for (const part of (process.env.REPORTS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)) {
    const [label, path] = part.includes('=') ? part.split('=') : [part.replace(/\W+/g, '_'), part];
    reports[label] = JSON.parse(readFileSync(path, 'utf8')) as SyncReport;
  }
  const poolsBy = new Map<string, Map<string, ProbePool[]>>();
  for (const [label, r] of Object.entries(reports)) {
    const m = new Map<string, ProbePool[]>();
    for (const p of r.pools) for (const a of [lower(p.token0), lower(p.token1)]) m.set(a, [...(m.get(a) ?? []), p]);
    poolsBy.set(label, m);
  }

  // ---- tokens ---------------------------------------------------------------
  let tokens: BlockscoutToken[];
  const cache = process.env.CACHE;
  if (cache && existsSync(cache)) {
    tokens = JSON.parse(readFileSync(cache, 'utf8')) as BlockscoutToken[];
    log(`token list from cache ${cache}: ${tokens.length}`);
    // REFRESH_TYPES=ERC-8056: add (or update) one token standard without re-reading the whole list.
    const refresh = (process.env.REFRESH_TYPES ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (refresh.length) {
      const key = process.env.BLOCKSCOUT_API_KEY;
      if (!key) throw new Error('BLOCKSCOUT_API_KEY is required for REFRESH_TYPES');
      const fresh = await fetchBlockscoutTokens(key, { types: refresh });
      const byAddress = new Map(tokens.map(t => [t.address, t]));
      for (const t of fresh) byAddress.set(t.address, t);
      tokens = [...byAddress.values()];
      writeFileSync(cache, JSON.stringify(tokens));
      log(`refreshed ${refresh.join(', ')}: ${fresh.length} tokens, list now ${tokens.length}`);
    }
  } else {
    const key = process.env.BLOCKSCOUT_API_KEY;
    if (!key) throw new Error('BLOCKSCOUT_API_KEY is required (or CACHE=<saved list>)');
    const max = Number(process.env.MAX_TOKENS ?? 0);
    tokens = await fetchBlockscoutTokens(key, {
      max: max > 0 ? max : undefined,
      onPage: (page, n) => page % 10 === 0 && log(`blockscout: page ${page}, ${n} tokens`),
    });
    writeFileSync(cache ?? join(outDir, 'blockscout-tokens.json'), JSON.stringify(tokens));
    log(`token list from Blockscout: ${tokens.length}`);
  }
  // Probed tokens that Blockscout did not return (e.g. past the page cap) still get a row.
  const known = new Set(tokens.map(t => t.address));
  for (const r of Object.values(reports)) {
    for (const p of r.tokens) {
      if (known.has(lower(p.address))) continue;
      known.add(lower(p.address));
      tokens.push({
        address: lower(p.address),
        name: p.symbol,
        symbol: p.symbol,
        decimals: null,
        holders: 0,
        marketCapUsd: 0,
        volume24hUsd: 0,
        priceUsd: 0,
        totalSupply: null,
        iconUrl: null,
        reputation: null,
        uiMultiplier: null,
      });
    }
  }

  // The real token of a symbol is the one with the largest market cap.
  const canonical = new Map<string, BlockscoutToken>();
  for (const t of tokens) {
    const s = t.symbol.toUpperCase();
    const cur = canonical.get(s);
    if (!cur || t.marketCapUsd > cur.marketCapUsd) canonical.set(s, t);
  }

  const rows: Row[] = tokens.map(t => {
    const { cat, why } = category(t, canonical);
    const probes: Record<string, ProbeSummary | null> = {};
    for (const [label, r] of Object.entries(reports)) probes[label] = summarize(t.address, r, poolsBy.get(label)!);
    const tier = liquidityTier(t, probes);
    const rk = risk(t, cat, tier, probes, why);
    return {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      category: cat,
      risk: rk.level,
      riskScore: rk.score,
      reasons: rk.reasons,
      liquidity: tier,
      marketCapUsd: Math.round(t.marketCapUsd),
      volume24hUsd: Math.round(t.volume24hUsd),
      holders: t.holders,
      priceUsd: t.priceUsd,
      probes,
    };
  });
  rows.sort((a, b) => b.marketCapUsd - a.marketCapUsd);

  // ---- files ----------------------------------------------------------------
  const labels = Object.keys(reports);
  const header = [
    'address',
    'symbol',
    'name',
    'category',
    'risk',
    'risk_score',
    'liquidity',
    'market_cap_usd',
    'volume_24h_usd',
    'holders',
    'price_usd',
    ...labels.flatMap(l => [
      `${l}_probe`,
      `${l}_max_eth`,
      `${l}_loss_bps_0.1eth`,
      `${l}_pools_allowed`,
      `${l}_pools_to_add`,
    ]),
    'reasons',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.address,
        r.symbol,
        r.name,
        r.category,
        r.risk,
        r.riskScore,
        r.liquidity,
        r.marketCapUsd,
        r.volume24hUsd,
        r.holders,
        r.priceUsd,
        ...labels.flatMap(l => {
          const p = r.probes[l];
          return p ? [p.status, p.maxPassingEth, p.lossAt01, p.poolsAllowed, p.poolsToAdd] : ['', '', '', '', ''];
        }),
        r.reasons.join('; '),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  writeFileSync(join(outDir, 'tokens.csv'), lines.join('\n') + '\n');
  writeFileSync(join(outDir, 'tokens.json'), JSON.stringify(rows, null, 1) + '\n');

  const count = <K extends string>(f: (r: Row) => K): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const r of rows) o[f(r)] = (o[f(r)] ?? 0) + 1;
    return o;
  };
  const table = (o: Record<string, number>): string =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} |`)
      .join('\n');
  const matrix = rows.reduce<Record<string, Record<string, number>>>((m, r) => {
    (m[r.category] ??= {})[r.risk] = (m[r.category][r.risk] ?? 0) + 1;
    return m;
  }, {});
  const money = (n: number): string =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
  const top = (cat: Category, n: number): string =>
    rows
      .filter(r => r.category === cat)
      .slice(0, n)
      .map(
        r =>
          `| ${r.symbol} | ${r.name.slice(0, 40)} | ${r.risk} | ${r.liquidity} | ${money(r.marketCapUsd)} | ${money(r.volume24hUsd)} |`
      )
      .join('\n');

  const md = [
    `# Token report ${new Date().toISOString().slice(0, 10)}`,
    '',
    `${rows.length} tokens on Robinhood Chain. Probe sources: ${labels.length ? labels.join(', ') : 'none (market data only)'}.`,
    `Probed: ${rows.filter(r => r.liquidity !== 'Not probed').length}. Heuristic classification: a review aid, not a verdict.`,
    '',
    '## By category and risk',
    '',
    '| Category | Low | Medium | High | Very high | Avoid | Total |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(matrix)
      .sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))
      .map(
        ([c, m]) =>
          `| ${c} | ${m.Low ?? 0} | ${m.Medium ?? 0} | ${m.High ?? 0} | ${m['Very high'] ?? 0} | ${m.Avoid ?? 0} | ${Object.values(m).reduce((x, y) => x + y, 0)} |`
      ),
    '',
    '## By liquidity tier',
    '',
    '| Tier | Tokens |',
    '|---|---|',
    table(count(r => r.liquidity)),
    '',
    '## Robinhood stock tokens (top 40)',
    '',
    '| Symbol | Name | Risk | Liquidity | Mcap | Vol 24h |',
    '|---|---|---|---|---|---|',
    top('RWA - Robinhood stock token', 40),
    '',
    '## Ondo tokenized',
    '',
    '| Symbol | Name | Risk | Liquidity | Mcap | Vol 24h |',
    '|---|---|---|---|---|---|',
    top('RWA - Ondo tokenized', 20),
    '',
    '## Established and stablecoins',
    '',
    '| Symbol | Name | Risk | Liquidity | Mcap | Vol 24h |',
    '|---|---|---|---|---|---|',
    top('Established', 30),
    top('Stablecoin', 10),
    '',
    `## Impersonators (${rows.filter(r => r.category === 'Impersonator').length}): never allowlist`,
    '',
    rows
      .filter(r => r.category === 'Impersonator')
      .slice(0, 25)
      .map(r => `- ${r.symbol} \`${r.address}\` (${r.name.slice(0, 40)}): ${r.reasons[0]}`)
      .join('\n'),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'summary.md'), md);
  log(`written to ${outDir}/ (tokens.csv, tokens.json, summary.md)`);
}

main().catch(e => {
  log(String(e));
  process.exit(1);
});
