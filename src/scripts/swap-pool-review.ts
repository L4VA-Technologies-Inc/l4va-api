/**
 * Review user requests for new vault tokens ("please add a pool for X") and find new candidates.
 * Run by hand; read-only: it signs and sends nothing.
 *
 * For every token it answers two questions and writes the answer into a local table:
 *
 *   1. Is the token trustworthy? Blockscout data + the heuristics of `swap-token-report.ts`
 *      (official Robinhood stock token, Ondo, stablecoin, meme, copy of another token, dead…).
 *   2. Can a vault trade it? The Uniswap Trading API with the vault's own route rules (v3 + v4
 *      without hooks): buy with ETH, sell straight back, at several sizes. The loss of that round
 *      trip is what a vault pays to enter and leave (pool fees + price impact).
 *
 * Verdict (thresholds are env, defaults below):
 *   ADD          round trip loses ≤ APPROVE_LOSS_BPS (5%) at REF_ETH (0.1 ETH)
 *   ADD_LIMITED  not ADD, but loses ≤ LIMIT_LOSS_BPS (15%) at SMALL_ETH (0.03 ETH): small vaults only
 *   REJECT       anything worse, no route, sell side missing, copy/dead token, bad Blockscout reputation
 *   ALREADY_OK   ADD or ADD_LIMITED and every pool of its routes is already allowlisted
 * For rejected tokens it also quotes with hooked v4 pools, to tell "no liquidity at all" from
 * "liquid only through hooked pools" (vaults do not support hooks yet).
 *
 * Output (REVIEW_DIR, default pool-review/, gitignored):
 *   registry.json / registry.csv / registry.md / index.html   latest result per token (all runs)
 *   runs/<timestamp>/replies.md    ready-to-send English replies, one block per request
 *   runs/<timestamp>/safe-add.json Safe Transaction Builder batch setPoolsAllowed(ids, true)
 *                                  for the ADD / ADD_LIMITED tokens of this run
 *   runs/<timestamp>/run.json      full data of this run
 *
 * Usage (from l4va-api):
 *   STACK=mainnet \                     # mainnet (default) | stage
 *   TOKENS=0xa,0xb \                    # tokens to review
 *   REQUEST="n0oxas: vault 1" \         # optional label shown in the table and replies
 *   DISCOVER=200 \                      # optional: also check Blockscout's top 200 tokens not reviewed
 *                                       # in the last RECHECK_DAYS (7) days; candidates = ADD verdicts
 *   npx ts-node -r tsconfig-paths/register src/scripts/swap-pool-review.ts
 *
 * PUBLISH_URL=https://<api host> (+ PUBLISH_ADMIN_TOKEN = the API's ADMIN_SERVICE_TOKEN) also replaces
 * the public /supported-tokens list (ALREADY_OK tokens of STACK) through the admin endpoint.
 * Vault holdings: every run reads custodyTokens() of all vaults of STACK (CHECK_VAULTS=0 skips) and
 * warns (stderr + runs/<time>/warnings.md) about held tokens that are not ALREADY_OK. CHECK_HELD=1
 * also reviews every held token.
 * RENDER_ONLY=1 rebuilds the table from registry.json without new quotes.
 * Other env: CONCURRENCY (4 tokens in parallel), TOKENS_FILE, SIZES_ETH (0.003,0.03,0.1), REF_ETH, SMALL_ETH, APPROVE_LOSS_BPS,
 * LIMIT_LOSS_BPS, SWAPPER, SAFE, REVIEW_DIR, ENV_FILE (.env: UNISWAP_API_KEY, ROBINHOOD_RPC_URL or
 * EVM_RPC_URL, BLOCKSCOUT_API_KEY).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { config } from 'dotenv';
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';

import {
  fetchBlockscoutToken,
  fetchBlockscoutTokens,
  searchBlockscoutTokens,
  type BlockscoutToken,
} from './blockscout-tokens';
import { category, type Category } from './swap-token-report';

import { NATIVE, planFromTradingApi, type RoutePlan } from '@/modules/vaults/index-vault/swap-route/multi-path-route';
import { UniswapTradingApiClient } from '@/modules/vaults/index-vault/swap-route/uniswap-trading-api.client';
import { EVM_PROTOCOL_VERSIONS, type EvmStack } from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import { guardedPoolOf, routePools, type GuardedPool } from '@/modules/vaults/processing-tx/onchain/evm-swap-guard';

const CHAIN_ID = 4663;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const HUBS = new Set<string>([NATIVE, WETH, USDG]);
const BATCH_SIZE = 40;
const TRADING_API = 'https://trade-api.gateway.uniswap.org/v1/quote';

const STACKS: Record<string, { stack: EvmStack; safe: Address }> = {
  stage: { stack: 'stage', safe: '0xcC3679a762F41C6f9727a6659bab519c3FbbF7c1' },
  mainnet: { stack: 'production', safe: '0x4733002467440E5881b84D19aC31e5c546Be9945' },
};

const ADAPTER_ABI = parseAbi([
  'function poolAllowed(bytes32) view returns (bool)',
  'function setPoolsAllowed(bytes32[] poolIds, bool allowed)',
]);
const FACTORY_ABI = parseAbi([
  'function vaultCount() view returns (uint256)',
  'function vaultAt(uint256) view returns (address)',
]);
const VAULT_ABI = parseAbi(['function custodyTokens() view returns (address[])']);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function name() view returns (string)']);

type Verdict = 'ALREADY_OK' | 'ADD' | 'ADD_LIMITED' | 'REJECT';

interface PoolRow {
  id: Hex;
  pair: string;
  venue: 'v3' | 'v4';
  feePct: number;
  tickSpacing: number;
  allowed: boolean;
}

interface Review {
  address: Address;
  symbol: string;
  name: string;
  category: Category | 'Unknown';
  trustNote: string;
  holders: number | null;
  marketCapUsd: number | null;
  /** Round-trip loss per size in bps; null = no route (buy or sell). */
  lossBps: Record<string, number | null>;
  /** Largest size whose round trip lost at most LIMIT_LOSS_BPS. */
  maxOkEth: string | null;
  /** Round-trip loss at SMALL_ETH when hooked v4 pools are allowed (only checked for rejects). */
  hookedLossBps: number | null;
  hooks: string[];
  verdict: Verdict;
  reason: string;
  pools: PoolRow[];
  toAdd: Hex[];
  /** Pools the public list re-checks on chain (ALREADY_OK only). */
  livePoolIds?: Hex[];
  /** Vaults of this stack that hold the token (custodyTokens) at review time. */
  heldBy?: string[];
  reply: string;
  request: string;
  checkedAt: string;
  stack: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
const lower = (a: string): Address => a.toLowerCase() as Address;
const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};
const pct = (bps: number | null | undefined): string =>
  bps === null || bps === undefined ? '—' : `${(bps / 100).toFixed(1)}%`;
const usd = (eth: number, ethUsd: number): string =>
  ethUsd ? `~$${Math.round(eth * ethUsd).toLocaleString('en-US')}` : `${eth} ETH`;

function currentSwapAdapter(stack: EvmStack): Address | null {
  const newest = (EVM_PROTOCOL_VERSIONS[CHAIN_ID] ?? [])
    .filter(v => v.stack === stack && v.swapAdapter)
    .sort((a, b) => b.version - a.version)[0];
  return newest?.swapAdapter ? lower(newest.swapAdapter) : null;
}

function tokensFromFile(path: string): Address[] {
  const text = readFileSync(path, 'utf8');
  try {
    const json = JSON.parse(text) as { tokens?: string[] } | string[];
    return (Array.isArray(json) ? json : (json.tokens ?? [])).filter(isAddress).map(lower);
  } catch {
    return text.split(/\s+/).filter(isAddress).map(lower);
  }
}

/** Raw round trip through the Trading API with hooks allowed; output amounts only (no adapter plan). */
async function hookedRoundTrip(
  apiKey: string,
  token: Address,
  amount: bigint,
  swapper: Address
): Promise<{ lossBps: number | null; hooks: string[] }> {
  const q = async (
    tokenIn: Address,
    tokenOut: Address,
    amt: bigint
  ): Promise<{ out: bigint; hooks: string[] } | null> => {
    const res = await fetch(TRADING_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-universal-router-version': '2.1.1' },
      body: JSON.stringify({
        tokenIn,
        tokenOut,
        tokenInChainId: CHAIN_ID,
        tokenOutChainId: CHAIN_ID,
        amount: amt.toString(),
        type: 'EXACT_INPUT',
        swapper,
        protocols: ['V3', 'V4'],
        hooksOptions: 'V4_HOOKS_INCLUSIVE',
        routingPreference: 'BEST_PRICE',
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { quote?: { output?: { amount?: string }; route?: { hooks?: string }[][] } };
    const out = body.quote?.output?.amount;
    if (!out) return null;
    const hooks = (body.quote?.route ?? [])
      .flat()
      .map(h => (h.hooks ?? '').toLowerCase())
      .filter(h => h && !/^0x0+$/.test(h));
    return { out: BigInt(out), hooks };
  };
  const buy = await q(NATIVE, token, amount);
  if (!buy || buy.out === 0n) return { lossBps: null, hooks: [] };
  const sell = await q(token, NATIVE, buy.out);
  if (!sell) return { lossBps: null, hooks: buy.hooks };
  const loss = sell.out >= amount ? 0 : Number(((amount - sell.out) * 10_000n) / amount);
  return { lossBps: loss, hooks: [...new Set([...buy.hooks, ...sell.hooks])] };
}

function safeBatch(swapper: Address, safe: Address, ids: Hex[], name: string, description: string): unknown {
  const transactions = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    transactions.push({
      to: swapper,
      value: '0',
      data: encodeFunctionData({
        abi: ADAPTER_ABI,
        functionName: 'setPoolsAllowed',
        args: [ids.slice(i, i + BATCH_SIZE), true],
      }),
      contractMethod: null,
      contractInputsValues: null,
    });
  }
  return {
    version: '1.0',
    chainId: String(CHAIN_ID),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: '2.1.0', createdFromSafeAddress: safe, createdFromOwnerAddress: '' },
    transactions,
  };
}

/** One English line for the user, per token. */
function replyLine(r: Omit<Review, 'reply'>, smallEth: number, refEth: number, ethUsd: number): string {
  const sym = `**${r.symbol}**`;
  const maxFee = Math.max(0, ...r.pools.filter(p => p.pair.includes(r.symbol)).map(p => p.feePct));
  const feeNote = maxFee >= 1 ? ` Its pools charge up to ${maxFee}% fee per trade.` : '';
  const lossSmall = r.lossBps[String(smallEth)];
  const lossRef = r.lossBps[String(refEth)];
  switch (r.verdict) {
    case 'ALREADY_OK':
      return (
        `${sym}: already supported, add it to your vault by its token address \`${r.address}\`.` +
        (lossRef === null || (lossRef ?? 0) > 500
          ? ` Heads-up: liquidity is thin, buying and selling back costs ~${pct(lossSmall)} at ${usd(smallEth, ethUsd)}, more on larger amounts.`
          : '')
      );
    case 'ADD':
      return `${sym}: approved. We're enabling its pool(s); this needs a multisig transaction, we'll confirm here once it's live.`;
    case 'ADD_LIMITED':
      return (
        `${sym}: we can enable it, but liquidity is thin: buying and selling back costs ~${pct(lossSmall)} at ` +
        `${usd(smallEth, ethUsd)}${lossRef !== null && lossRef !== undefined ? ` and ~${pct(lossRef)} at ${usd(refEth, ethUsd)}` : ''}.` +
        `${feeNote} Fine for small vaults; let us know if you still want it.`
      );
    case 'REJECT':
    default: {
      let why: string;
      if (r.category === 'Impersonator')
        why = `we can't verify this contract as the official token (${r.trustNote}), so we can't list it.`;
      else if (r.category === 'Dead') why = 'this token has no market, holders or trading activity.';
      else if (r.reason.startsWith('Blockscout reputation'))
        why = "the block explorer flags this token, so we can't list it.";
      else if (Object.values(r.lossBps).every(v => v === null))
        why = 'Uniswap has no pool a vault can trade through right now.';
      else
        why =
          `its Uniswap pools are too thin: buying ${usd(smallEth, ethUsd)} and selling it back loses ` +
          `${pct(lossSmall ?? Object.values(r.lossBps).find(v => v !== null))}, so a vault could not exit the position.`;
      const hooked =
        r.hookedLossBps !== null && r.hookedLossBps <= 1500
          ? " It does trade through special (hooked) Uniswap pools, which vaults don't support yet; we'll let you know when they do."
          : '';
      return `${sym}: not possible for now, ${why}${hooked}`;
    }
  }
}

/**
 * Public list for the /supported-tokens page: tokens a vault can trade today (ALREADY_OK, current
 * stack only), sent to the API admin endpoint, which replaces the whole list of its chain. Holds
 * only what the page shows plus the pool ids the API re-checks on chain: no reasons or requesters.
 */
async function publish(
  url: string,
  token: string,
  registry: Record<string, Review>,
  stack: string,
  refEth: string,
  approveBps: number
): Promise<number> {
  const rows = Object.values(registry).filter(r => r.verdict === 'ALREADY_OK' && r.stack === stack);
  const missing = rows.filter(r => !r.livePoolIds?.length);
  if (missing.length) {
    throw new Error(
      `no pool ids for ${missing.map(r => r.symbol).join(', ')} (reviewed by an older script); re-run the review for them first`
    );
  }
  const tokens = rows.map(r => {
    const loss = r.lossBps[refEth];
    return {
      address: r.address,
      symbol: r.symbol,
      name: r.name,
      category: r.category,
      liquidity: loss !== null && loss !== undefined && loss <= approveBps ? 'good' : 'thin',
      roundTripLossBps: loss ?? null,
      poolIds: r.livePoolIds,
      checkedAt: r.checkedAt,
    };
  });
  const res = await fetch(`${url.replace(/\/$/, '')}/api/v1/vaults/index/supported-tokens`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ refEth, tokens }),
  });
  if (!res.ok) throw new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { count: number }).count;
}

/**
 * Every token held by a vault of `stack` on chain 4663: enumerates each factory of the stack
 * (EVM_PROTOCOL_VERSIONS) with vaultCount/vaultAt and reads custodyTokens() of every vault.
 * Read-only; vaults that fail to answer (e.g. older versions without custodyTokens) are skipped.
 */
async function heldTokens(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { readContract(args: any): Promise<unknown> },
  stack: EvmStack
): Promise<{ held: Map<string, string[]>; vaults: number; skipped: number }> {
  const factories = [
    ...new Set(
      (EVM_PROTOCOL_VERSIONS[CHAIN_ID] ?? []).filter(v => v.stack === stack && v.factory).map(v => lower(v.factory))
    ),
  ];
  // Vaults also list our own contracts as custody "tokens" (e.g. LP-adapter position shares).
  const protocolAddresses = new Set(
    (EVM_PROTOCOL_VERSIONS[CHAIN_ID] ?? []).flatMap(v =>
      Object.values(v)
        .filter((x): x is string => typeof x === 'string' && isAddress(x))
        .map(x => x.toLowerCase())
    )
  );
  const held = new Map<string, string[]>();
  let vaults = 0;
  let skipped = 0;
  for (const factory of factories) {
    const count = Number(
      await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'vaultCount' }).catch(() => 0n)
    );
    for (let i = 0; i < count; i++) {
      const vault = lower(
        String(
          await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'vaultAt', args: [BigInt(i)] })
        )
      );
      const tokens = (await client
        .readContract({ address: vault, abi: VAULT_ABI, functionName: 'custodyTokens' })
        .catch(() => null)) as Address[] | null;
      if (!tokens) {
        skipped++;
        continue;
      }
      vaults++;
      for (const t of tokens.map(lower)) {
        if (HUBS.has(t) || protocolAddresses.has(t)) continue;
        held.set(t, [...(held.get(t) ?? []), vault]);
      }
    }
  }
  return { held, vaults, skipped };
}

function writeTables(dir: string, registry: Record<string, Review>, approveBps: number, limitBps: number): void {
  const order: Record<Verdict, number> = { ADD: 0, ADD_LIMITED: 1, ALREADY_OK: 2, REJECT: 3 };
  const rows = Object.values(registry).sort(
    (a, b) => order[a.verdict] - order[b.verdict] || b.checkedAt.localeCompare(a.checkedAt)
  );
  const sizes = [...new Set(rows.flatMap(r => Object.keys(r.lossBps)))].sort((a, b) => Number(a) - Number(b));
  const cols = [
    'verdict',
    'symbol',
    'name',
    'category',
    ...sizes.map(s => `loss@${s}ETH`),
    'maxOkEth',
    'hookedLoss',
    'poolsToAdd',
    'heldBy',
    'reason',
    'request',
    'checkedAt',
    'stack',
    'address',
  ];
  const cells = (r: Review): string[] => [
    r.verdict,
    r.symbol,
    r.name,
    r.category,
    ...sizes.map(s => (s in r.lossBps ? pct(r.lossBps[s]) : '')),
    r.maxOkEth ?? '—',
    pct(r.hookedLossBps),
    String(r.heldBy?.length ?? ''),
    r.reason,
    r.request,
    r.checkedAt.slice(0, 16).replace('T', ' '),
    r.stack,
    r.address,
  ];
  const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
  writeFileSync(
    join(dir, 'registry.csv'),
    [cols, ...rows.map(cells)].map(r => r.map(csvCell).join(',')).join('\n') + '\n'
  );
  const md = (v: string): string => v.replace(/\|/g, '\\|');
  writeFileSync(
    join(dir, 'registry.md'),
    `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n` +
      rows.map(r => `| ${cells(r).map(md).join(' | ')} |`).join('\n') +
      '\n'
  );
  const esc = (v: string): string =>
    v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const verdicts: Verdict[] = ['ADD', 'ADD_LIMITED', 'ALREADY_OK', 'REJECT'];
  const verdictLabel: Record<Verdict, string> = {
    ADD: 'Add',
    ADD_LIMITED: 'Add (small only)',
    ALREADY_OK: 'Already works',
    REJECT: 'Reject',
  };
  const lossCell = (bps: number | null | undefined, present: boolean): string => {
    if (!present) return '<td class="n"></td>';
    if (bps === null || bps === undefined)
      return '<td class="n" data-s="99999"><span class="l bad">no route</span></td>';
    const cls = bps <= approveBps ? 'good' : bps <= limitBps ? 'warn' : 'bad';
    return `<td class="n" data-s="${bps}"><span class="l ${cls}">${pct(bps)}</span></td>`;
  };
  const heldCell = (r: Review): string => {
    const n = r.heldBy?.length ?? 0;
    if (!n) return '<td class="n mut">—</td>';
    const risky = r.verdict !== 'ALREADY_OK';
    return `<td class="n" data-s="${n}" title="${esc(r.heldBy!.join('\n'))}"><span class="l ${risky ? 'bad' : ''}">${n}${risky ? ' ⚠' : ''}</span></td>`;
  };
  const counts = Object.fromEntries(verdicts.map(v => [v, rows.filter(r => r.verdict === v).length]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Vault token reviews</title>
<meta name="color-scheme" content="light dark">
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d0d7de;--head:#f6f8fa;--hover:#f6f8fa;
--good:#1a7f37;--goodbg:#dafbe1;--warn:#9a6700;--warnbg:#fff8c5;--bad:#cf222e;--badbg:#ffebe9;--info:#0969da;--infobg:#ddf4ff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--head:#161b22;--hover:#161b22;
--good:#3fb950;--goodbg:#12261e;--warn:#d29922;--warnbg:#272115;--bad:#f85149;--badbg:#2d1214;--info:#58a6ff;--infobg:#121d2f}}
*{box-sizing:border-box}body{font:13px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:20px 24px;background:var(--bg);color:var(--fg)}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 16px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.chip{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit}
.chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
input[type=search]{font:inherit;padding:5px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:260px;margin-left:auto}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
thead th{position:sticky;top:0;background:var(--head);color:var(--fg);font-weight:600;font-size:12px;cursor:pointer;user-select:none;white-space:nowrap;z-index:1}
thead tr:first-child th{border-bottom:0;padding-bottom:0}thead th.grp{cursor:default;text-align:center;color:var(--mut);font-weight:500}
tbody tr:hover{background:var(--hover)}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.v{display:inline-block;border-radius:6px;padding:2px 8px;font-weight:600;font-size:12px;white-space:nowrap}
.v.ADD{color:var(--good);background:var(--goodbg)}.v.ADD_LIMITED{color:var(--warn);background:var(--warnbg)}
.v.ALREADY_OK{color:var(--info);background:var(--infobg)}.v.REJECT{color:var(--bad);background:var(--badbg)}
.l{border-radius:4px;padding:1px 5px}.l.good{color:var(--good)}.l.warn{color:var(--warn);background:var(--warnbg)}.l.bad{color:var(--bad);background:var(--badbg)}
.sym{font-weight:600;font-size:14px}.mut{color:var(--mut);font-size:12px}
code{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut)}
button.copy{font:inherit;font-size:11px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:5px;padding:1px 7px;cursor:pointer;margin-left:4px}
details{margin-top:6px}summary{cursor:pointer;color:var(--info);font-size:12px}
.reply{margin:6px 0;padding:8px;border-left:3px solid var(--line);background:var(--head);border-radius:4px;max-width:560px}
.pools{border-collapse:collapse;margin-top:4px}.pools td{border:0;padding:1px 8px 1px 0;font-size:12px}
.legend{color:var(--mut);font-size:12px;margin-top:14px}
</style></head><body>
<h1>Vault token reviews</h1>
<p class="sub">${rows.length} tokens · round trip = buy with ETH and sell straight back through pools a vault can use ·
<span class="l good">≤ ${pct(approveBps)}</span> ok at 0.1 ETH · <span class="l warn">≤ ${pct(limitBps)}</span> small vaults only · <span class="l bad">worse</span></p>
<div class="bar">
<button class="chip" data-f="" aria-pressed="true">All ${rows.length}</button>
${verdicts.map(v => `<button class="chip" data-f="${v}" aria-pressed="false">${verdictLabel[v]} ${counts[v]}</button>`).join('\n')}
<input type="search" id="q" placeholder="Search symbol, name, address, request…">
</div>
<table><thead>
<tr><th class="grp" colspan="3"></th><th class="grp" colspan="${sizes.length}">Round-trip loss at size (ETH)</th><th class="grp" colspan="6"></th></tr>
<tr><th>Verdict</th><th>Token</th><th>Trust</th>${sizes.map(s => `<th class="n">${s}</th>`).join('')}<th class="n">Max ok</th><th class="n">Hooked</th><th class="n">To add</th><th class="n">Held by</th><th>Reason</th><th>Request / checked</th></tr>
</thead><tbody>
${rows
  .map(r => {
    const hooked = r.hooks.length ? lossCell(r.hookedLossBps, true) : '<td class="n mut">—</td>';
    const pools = r.pools.length
      ? `<table class="pools">${r.pools
          .map(
            p =>
              `<tr><td>${p.allowed ? '✅' : '❌'}</td><td>${esc(p.pair)}</td><td>${p.venue} ${p.feePct}%</td><td><code>${p.id}</code></td></tr>`
          )
          .join('')}</table>`
      : '<div class="mut">no pools on a passing route</div>';
    return `<tr data-v="${r.verdict}">
<td><span class="v ${r.verdict}">${verdictLabel[r.verdict]}</span></td>
<td><div class="sym">${esc(r.symbol)}</div><div class="mut">${esc(r.name)}</div><code>${r.address}</code><button class="copy" data-c="${r.address}">copy</button></td>
<td>${esc(r.category)}<div class="mut">${esc(r.trustNote)}</div></td>
${sizes.map(s => lossCell(r.lossBps[s], s in r.lossBps)).join('')}
<td class="n">${r.maxOkEth ?? '—'}</td>${hooked}<td class="n">${r.toAdd.length || '—'}</td>${heldCell(r)}
<td>${esc(r.reason)}<details><summary>Reply &amp; pools</summary><div class="reply">${esc(r.reply)}</div><button class="copy" data-c="${esc(r.reply)}">Copy reply</button>${pools}</details></td>
<td>${esc(r.request)}<div class="mut">${r.checkedAt.slice(0, 16).replace('T', ' ')} · ${r.stack}</div></td></tr>`;
  })
  .join('\n')}
</tbody></table>
<p class="legend">Data: Uniswap Trading API (v3 + hookless v4, same rules as vault trades), Blockscout, on-chain poolAllowed. Generated by swap-pool-review.ts.</p>
<script>
let f='',q='';const rows=[...document.querySelectorAll('tbody>tr[data-v]')];
const apply=()=>rows.forEach(tr=>tr.hidden=(f&&tr.dataset.v!==f)||(q&&!tr.textContent.toLowerCase().includes(q)));
document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{f=b.dataset.f;document.querySelectorAll('.chip').forEach(x=>x.setAttribute('aria-pressed',x===b));apply()});
document.getElementById('q').oninput=e=>{q=e.target.value.toLowerCase();apply()};
document.querySelectorAll('button.copy').forEach(b=>b.onclick=()=>{navigator.clipboard.writeText(b.dataset.c);const t=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=t,1200)});
const ths=[...document.querySelectorAll('thead tr:last-child th')];
ths.forEach((th,i)=>th.onclick=()=>{const tb=document.querySelector('tbody');const d=th.dataset.d=th.dataset.d==='1'?'-1':'1';
const val=tr=>{const c=tr.cells[i];if(c.dataset.s)return+c.dataset.s;const t=c.innerText.trim();const n=parseFloat(t);return isNaN(n)?(t==='—'||t===''?Infinity:t):n};
rows.sort((a,b)=>{const x=val(a),y=val(b);return(x>y?1:x<y?-1:0)*d});rows.forEach(r=>tb.appendChild(r))});
</script>
</body></html>
`;
  writeFileSync(join(dir, 'index.html'), html);
}

async function main(): Promise<void> {
  config({ path: process.env.ENV_FILE || '.env', quiet: true });

  const stackName = process.env.STACK ?? 'mainnet';
  const stack = STACKS[stackName];
  if (!stack) throw new Error(`STACK must be one of ${Object.keys(STACKS).join(', ')}`);
  const swapper = process.env.SWAPPER ? lower(process.env.SWAPPER) : currentSwapAdapter(stack.stack);
  if (!swapper) throw new Error(`no swap adapter for ${stackName}; set SWAPPER`);
  const safe = lower(process.env.SAFE ?? stack.safe);
  const rpc = process.env.EVM_RPC_URL ?? process.env.ROBINHOOD_RPC_URL;
  if (!rpc) throw new Error('EVM_RPC_URL (or ROBINHOOD_RPC_URL) is required');
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new Error('UNISWAP_API_KEY is required');
  const bsKey = process.env.BLOCKSCOUT_API_KEY;
  if (!bsKey) log('BLOCKSCOUT_API_KEY not set: no token trust data (category Unknown)');

  const client = createPublicClient({ transport: http(rpc, { batch: true, retryCount: 3 }) }) as unknown as {
    getChainId(): Promise<number>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract(args: any): Promise<unknown>;
  };
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN_ID}`);
  const api = new UniswapTradingApiClient({ get: (k: string) => process.env[k] } as never);

  const sizes = // 0.3 / 1 ETH do not change the verdict; add them with SIZES_ETH when the extra columns help.
    (list(process.env.SIZES_ETH).length ? list(process.env.SIZES_ETH) : ['0.003', '0.03', '0.1']).sort(
      (a, b) => Number(a) - Number(b)
    );
  const refEth = process.env.REF_ETH ?? '0.1';
  const smallEth = process.env.SMALL_ETH ?? '0.03';
  for (const s of [refEth, smallEth]) if (!sizes.includes(s)) sizes.push(s);
  sizes.sort((a, b) => Number(a) - Number(b));
  const approveBps = Number(process.env.APPROVE_LOSS_BPS ?? 500);
  const limitBps = Number(process.env.LIMIT_LOSS_BPS ?? 1500);
  const request = process.env.REQUEST ?? '';

  const dir = process.env.REVIEW_DIR ?? 'pool-review';
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, 'registry.json');
  const registry: Record<string, Review> = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf8'))
    : {};

  if (process.env.RENDER_ONLY === '1') {
    writeTables(dir, registry, approveBps, limitBps);
    if (process.env.PUBLISH_URL) {
      const adminToken = process.env.PUBLISH_ADMIN_TOKEN ?? process.env.ADMIN_SERVICE_TOKEN;
      if (!adminToken) throw new Error('PUBLISH_URL needs PUBLISH_ADMIN_TOKEN (the API ADMIN_SERVICE_TOKEN)');
      const n = await publish(process.env.PUBLISH_URL, adminToken, registry, stackName, refEth, approveBps);
      log(`published ${n} supported tokens to ${process.env.PUBLISH_URL}`);
    }
    log(`re-rendered ${dir}/index.html from registry.json (${Object.keys(registry).length} tokens)`);
    return;
  }

  // ---- token list ---------------------------------------------------------
  const requested = [
    ...list(process.env.TOKENS).filter(isAddress).map(lower),
    ...list(process.env.TOKENS_FILE).flatMap(tokensFromFile),
  ];
  const meta = new Map<string, BlockscoutToken>();
  const discover = Number(process.env.DISCOVER ?? 0);
  const discovered: Address[] = [];
  if (discover > 0) {
    if (!bsKey) throw new Error('DISCOVER needs BLOCKSCOUT_API_KEY');
    const recheckMs = Number(process.env.RECHECK_DAYS ?? 7) * 86_400_000;
    for (const t of await fetchBlockscoutTokens(bsKey, { max: discover })) {
      meta.set(t.address, t);
      const prev = registry[t.address];
      if (HUBS.has(t.address) || (prev && Date.now() - Date.parse(prev.checkedAt) < recheckMs)) continue;
      discovered.push(lower(t.address));
    }
    log(`discover: ${discovered.length} of the top ${discover} tokens not reviewed recently`);
  }
  // Tokens vaults hold today: flagged in the table, warned about when they are not tradable.
  let held = new Map<string, string[]>();
  if (process.env.CHECK_VAULTS !== '0') {
    const h = await heldTokens(client, stack.stack);
    held = h.held;
    log(
      `vault holdings: ${h.vaults} vaults of ${stackName}, ${held.size} distinct tokens` +
        (h.skipped ? ` (${h.skipped} vaults without custodyTokens skipped)` : '')
    );
  }
  const heldExtra = process.env.CHECK_HELD === '1' ? ([...held.keys()] as Address[]) : [];
  const tokens = [...new Set([...requested, ...discovered, ...heldExtra])].filter(t => !HUBS.has(t));
  if (!tokens.length) throw new Error('nothing to review: set TOKENS, TOKENS_FILE or DISCOVER');

  const ethUsd = bsKey ? ((await fetchBlockscoutToken(bsKey, WETH).catch(() => null))?.priceUsd ?? 0) : 0;
  const symbols = new Map<string, string>([
    [NATIVE, 'ETH'],
    [WETH, 'WETH'],
    [USDG, 'USDG'],
  ]);
  const symbolOf = async (t: string): Promise<string> => {
    if (!symbols.has(t))
      symbols.set(
        t,
        String(
          await client.readContract({ address: t, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => t.slice(0, 8))
        )
      );
    return symbols.get(t)!;
  };

  const quote = async (tokenIn: Address, tokenOut: Address, amount: bigint): Promise<RoutePlan | null> => {
    const resp = await api.quoteExactInput(tokenIn, tokenOut, amount, swapper);
    if ('noRoute' in resp) return null;
    try {
      return planFromTradingApi(resp, tokenIn, tokenOut, amount, WETH);
    } catch {
      return null; // route uses something the adapter cannot execute (hooks, v2…)
    }
  };

  const runAt = new Date().toISOString();
  const results: Review[] = [];
  let done = 0;
  const reviewOne = async (token: Address): Promise<void> => {
    // ---- trust ----
    let info = meta.get(token) ?? null;
    if (!info && bsKey) info = await fetchBlockscoutToken(bsKey, token).catch(() => null);
    let cat: Category | 'Unknown' = 'Unknown';
    let trustNote = '';
    if (info) {
      const same = bsKey ? await searchBlockscoutTokens(bsKey, info.symbol).catch(() => []) : [];
      const canonical = new Map<string, BlockscoutToken>();
      for (const t of same.filter(t => t.symbol.toUpperCase() === info!.symbol.toUpperCase()))
        if (
          !canonical.has(t.symbol.toUpperCase()) ||
          canonical.get(t.symbol.toUpperCase())!.marketCapUsd < t.marketCapUsd
        )
          canonical.set(t.symbol.toUpperCase(), t);
      const c = category(info, canonical);
      cat = c.cat;
      trustNote = c.why ?? `${info.holders} holders, mcap $${Math.round(info.marketCapUsd).toLocaleString('en-US')}`;
      if (info.reputation && info.reputation !== 'ok') trustNote += `; Blockscout reputation: ${info.reputation}`;
    }
    const symbol = info?.symbol || (await symbolOf(token));
    symbols.set(token, symbol);
    const name =
      info?.name ||
      String(await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => ''));

    // ---- liquidity ----
    const lossBps: Record<string, number | null> = {};
    let maxOkEth: string | null = null;
    const seen = new Map<string, GuardedPool>();
    for (const s of sizes) {
      const amount = parseEther(s);
      let loss: number | null = null;
      try {
        const buy = await quote(NATIVE, token, amount);
        if (buy && buy.amountOut > 0n) {
          const sell = await quote(token, NATIVE, buy.amountOut);
          if (sell) {
            loss = sell.amountOut >= amount ? 0 : Number(((amount - sell.amountOut) * 10_000n) / amount);
            if (loss <= limitBps) for (const p of [...routePools(buy), ...routePools(sell)]) seen.set(p.id, p);
          }
        }
      } catch (err) {
        log(`  ${symbol} @${s}: Trading API error ${(err as Error).message.split('\n')[0]}`);
      }
      lossBps[s] = loss;
      if (loss !== null && loss <= limitBps) maxOkEth = s;
      else if (Number(s) >= Number(refEth)) break; // larger sizes only lose more
    }

    // ---- verdict ----
    let verdict: Verdict;
    let reason: string;
    const lr = lossBps[refEth];
    const ls = lossBps[smallEth];
    if (cat === 'Impersonator' || cat === 'Dead') {
      verdict = 'REJECT';
      reason = `${cat}: ${trustNote}`;
    } else if (info?.reputation && info.reputation !== 'ok') {
      verdict = 'REJECT';
      reason = `Blockscout reputation: ${info.reputation}`;
    } else if (lr !== null && lr !== undefined && lr <= approveBps) {
      verdict = 'ADD';
      reason = `round trip ${pct(lr)} at ${refEth} ETH`;
    } else if (ls !== null && ls !== undefined && ls <= limitBps) {
      verdict = 'ADD_LIMITED';
      reason = `thin: ${pct(ls)} at ${smallEth} ETH, ${lr === null || lr === undefined ? 'no route' : pct(lr)} at ${refEth} ETH`;
    } else {
      verdict = 'REJECT';
      const any = Object.entries(lossBps).find(([, v]) => v !== null);
      reason = any ? `illiquid: ${pct(any[1])} at ${any[0]} ETH` : 'no route a vault can use';
    }

    let hookedLossBps: number | null = null;
    let hooks: string[] = [];
    if (verdict === 'REJECT' && cat !== 'Impersonator' && cat !== 'Dead') {
      const h = await hookedRoundTrip(apiKey, token, parseEther(smallEth), swapper).catch(() => ({
        lossBps: null,
        hooks: [],
      }));
      hookedLossBps = h.lossBps;
      hooks = h.hooks;
      if (hooks.length && hookedLossBps !== null && hookedLossBps <= limitBps)
        reason += `; liquid via hooked pools (${pct(hookedLossBps)}, hooks ${hooks.join(', ')}), not supported yet`;
    }

    const isAllowed = async (id: Hex): Promise<boolean> =>
      (await client.readContract({ address: swapper, abi: ADAPTER_ABI, functionName: 'poolAllowed', args: [id] })) ===
      true;
    const pools: PoolRow[] = await Promise.all(
      [...seen.values()].map(async p => ({
        id: p.id,
        pair: `${await symbolOf(p.token0)}/${await symbolOf(p.token1)}`,
        venue: p.venue,
        feePct: p.fee / 10_000,
        tickSpacing: p.tickSpacing,
        allowed: await isAllowed(p.id),
      }))
    );
    let toAdd = verdict === 'REJECT' ? [] : pools.filter(p => !p.allowed).map(p => p.id);
    // Uniswap's best route may prefer new pools even when the token already trades through an
    // allowlisted direct pool (the API then routes around the missing ones). Extra pools are
    // extra attack surface, so they are only listed as optional, never batched.
    const directIds: Hex[] = [];
    if (verdict !== 'REJECT' && toAdd.length) {
      // Allowlisted pools pairing the token with a hub: those seen on routes (any fee tier), plus
      // the standard v3 tiers and v4 hookless (fee, tickSpacing) pairs, which Uniswap may not quote.
      for (const p of seen.values())
        if (
          pools.some(r => r.id === p.id && r.allowed) &&
          [p.token0, p.token1].includes(token) &&
          [p.token0, p.token1].some(t => HUBS.has(t))
        )
          directIds.push(p.id);
      const candidates = [
        ...[WETH, USDG].flatMap(hub =>
          [100, 500, 3000, 10_000].map(fee =>
            guardedPoolOf({ venue: 0, tokenIn: token, tokenOut: hub, fee, tickSpacing: 0 })
          )
        ),
        ...[NATIVE, USDG].flatMap(hub =>
          (
            [
              [100, 1],
              [500, 10],
              [3000, 60],
              [10_000, 200],
            ] as const
          ).map(([fee, tickSpacing]) => guardedPoolOf({ venue: 1, tokenIn: token, tokenOut: hub, fee, tickSpacing }))
        ),
      ];
      const fresh = candidates.map(c => c.id).filter(id => !directIds.includes(id));
      const answers = await Promise.all(fresh.map(isAllowed));
      directIds.push(...fresh.filter((_, k) => answers[k]));
    }
    const direct = directIds.length > 0;
    if (verdict !== 'REJECT' && (toAdd.length === 0 || direct)) {
      const optional = direct ? `; ${toAdd.length} optional pool(s) would improve the price` : '';
      reason = `${reason} (${verdict === 'ADD' ? 'good' : 'thin'}, already allowlisted${optional})`;
      verdict = 'ALREADY_OK';
      toAdd = [];
    }
    // Pools the public list re-checks on chain: the allowlisted direct pools, else every route pool.
    const livePoolIds = verdict === 'ALREADY_OK' ? (direct ? directIds : pools.map(p => p.id)) : [];

    const base = {
      address: token,
      symbol,
      name,
      category: cat,
      trustNote,
      holders: info?.holders ?? null,
      marketCapUsd: info?.marketCapUsd ?? null,
      lossBps,
      maxOkEth,
      hookedLossBps,
      hooks,
      verdict,
      reason,
      pools,
      toAdd,
      livePoolIds,
      request: requested.includes(token) ? request : discovered.includes(token) ? 'discover' : 'held by vaults',
      heldBy: held.get(token) ?? [],
      checkedAt: runAt,
      stack: stackName,
    };
    const review: Review = { ...base, reply: replyLine(base, Number(smallEth), Number(refEth), ethUsd) };
    results.push(review);
    registry[token] = review;
    log(`[${++done}/${tokens.length}] ${symbol.padEnd(10)} ${verdict.padEnd(11)} ${reason}`);
  };

  // Tokens run in parallel; the Trading API client still spaces every request by 200 ms (one
  // queue for the process), so more workers only overlap the waiting, never exceed its rate.
  const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 4));
  const queue = [...tokens];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          await reviewOne(t);
        } catch (err) {
          log(`  ${t}: review failed, skipped (${(err as Error).message.split('\n')[0]})`);
        }
      }
    })
  );
  const order = new Map(tokens.map((t, k) => [t as string, k]));
  results.sort((a, b) => order.get(a.address)! - order.get(b.address)!);

  // ---- output -------------------------------------------------------------
  const runDir = join(dir, 'runs', runAt.replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  writeTables(dir, registry, approveBps, limitBps);
  if (process.env.PUBLISH_URL) {
    const adminToken = process.env.PUBLISH_ADMIN_TOKEN ?? process.env.ADMIN_SERVICE_TOKEN;
    if (!adminToken) throw new Error('PUBLISH_URL needs PUBLISH_ADMIN_TOKEN (the API ADMIN_SERVICE_TOKEN)');
    const n = await publish(process.env.PUBLISH_URL, adminToken, registry, stackName, refEth, approveBps);
    log(`published ${n} supported tokens to ${process.env.PUBLISH_URL}`);
  }
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify(
      { stack: stackName, swapper, safe, ethUsd, settings: { sizes, refEth, smallEth, approveBps, limitBps }, results },
      null,
      2
    ) + '\n'
  );

  // Tokens vaults hold that a vault could not trade right now (rejected, or pools missing).
  const atRisk = results.filter(r => r.heldBy?.length && r.verdict !== 'ALREADY_OK');
  if (atRisk.length) {
    const lines = atRisk.map(
      r =>
        `- ${r.symbol} \`${r.address}\`: ${r.verdict}, ${r.reason}. Held by ${r.heldBy!.length} vault(s): ${r.heldBy!.join(', ')}`
    );
    writeFileSync(
      join(runDir, 'warnings.md'),
      `# Held tokens a vault may not be able to trade\n\nDo not remove their pools; check these vaults.\n\n${lines.join('\n')}\n`
    );
    log(`\n⚠️  ${atRisk.length} token(s) held by vaults are not fully tradable:\n${lines.join('\n')}\n`);
  }

  const asked = results.filter(r => r.request === request && r.request !== 'discover');
  const candidates = results.filter(
    r => r.request === 'discover' && (r.verdict === 'ADD' || r.verdict === 'ADD_LIMITED')
  );
  const replies = [
    `# Replies (${runAt.slice(0, 10)}${request ? `, ${request}` : ''})`,
    '',
    asked.length
      ? ['Hi! We checked the tokens you asked about:', '', ...asked.map(r => `- ${r.reply}`), ''].join('\n')
      : '',
    candidates.length
      ? [
          `## Discover: ${candidates.length} new candidate(s)`,
          '',
          ...candidates.map(r => `- ${r.symbol} \`${r.address}\` (${r.category}): ${r.verdict}, ${r.reason}`),
          '',
        ].join('\n')
      : '',
  ].join('\n');
  writeFileSync(join(runDir, 'replies.md'), replies);

  const addIds = [...new Set(results.flatMap(r => r.toAdd))];
  if (addIds.length) {
    const names = results.filter(r => r.toAdd.length).map(r => r.symbol);
    writeFileSync(
      join(runDir, 'safe-add.json'),
      JSON.stringify(
        safeBatch(
          swapper,
          safe,
          addIds,
          `Guarded swap: allow ${addIds.length} pools for ${names.join(', ')} (${stackName}, ${runAt.slice(0, 10)})`,
          `setPoolsAllowed(ids, true) on ${swapper}; reviewed by swap-pool-review.ts`
        ),
        null,
        2
      ) + '\n'
    );
  }
  log(
    `\n${results.length} token(s): ${['ADD', 'ADD_LIMITED', 'ALREADY_OK', 'REJECT']
      .map(v => `${v} ${results.filter(r => r.verdict === v).length}`)
      .join(', ')}\n` +
      `table: ${dir}/index.html (also registry.csv / registry.md)\n` +
      `this run: ${runDir}/ (replies.md${addIds.length ? `, safe-add.json with ${addIds.length} pools` : ''})`
  );
  process.stdout.write(replies + '\n');
}

main().catch(err => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
