/**
 * Sync the guarded swap adapter's pool allowlist with what Uniswap routes through today.
 * Run by hand; read-only: it signs and sends nothing.
 *
 * For every token (Blockscout top list + TOKENS + TOKENS_FILE + tokens held by VAULTS), it
 * asks the Uniswap Trading API — the same source and route rules vault trades use — for
 * ETH → token → ETH at several sizes (REPEATS times each, since Uniswap splits trades
 * differently from one quote to the next). A size passes when the round trip loses at most
 * MAX_ROUNDTRIP_LOSS_BPS. Then it reads `poolAllowed` on the adapter for every pool it saw and writes:
 *
 *   <OUT_DIR>/report.json       every token and pool, with status and on-chain state
 *   <OUT_DIR>/safe-add.json     Safe Transaction Builder batch: setPoolsAllowed(ids, true)
 *                               for pools of passing routes that are not allowlisted yet
 *   <OUT_DIR>/safe-remove.json  only with WRITE_REMOVE=1: setPoolsAllowed(ids, false) for
 *                               allowlisted pools whose tokens all have no route or lose at
 *                               least REMOVE_MIN_LOSS_BPS (default 90%) at the smallest size.
 *                               Never proposed: pools on a passing route, hub pools (ETH/WETH/
 *                               USDG only), and pools of tokens held by VAULTS — pass every
 *                               live vault there before writing a removal batch.
 *
 * NEW_ADAPTER=1 (a guarded adapter that is not deployed yet, e.g. production before V13): skips the
 * on-chain checks, treats every pool of a passing route as not allowlisted, and writes
 * `<OUT_DIR>/pools.json` ({ ids }) for `script/safe-batch-guarded-adapters.sh <stack> pools.json`
 * instead of a Safe batch. SWAPPER is then only the address the routes are quoted for.
 *
 * Upload a batch in the Safe app (Transaction Builder → drag the JSON). Review the report first.
 *
 * Usage (from l4va-api):
 *   STACK=stage \                       # stage | mainnet: picks adapter + Safe (override with SWAPPER / SAFE)
 *   TOP_N=500 \                         # Blockscout top tokens by market cap (0 = none); needs BLOCKSCOUT_API_KEY
 *   TOKENS=0xa,0xb \                    # optional extra tokens
 *   TOKENS_FILE=../vault-contract-solidity/deployments/swap-pools-stage-v13-extra.json \
 *                                       # optional; JSON with a `tokens` array, or one address per line
 *   VAULTS=0xv1,0xv2 \                  # optional; adds every token these vaults hold (custodyTokens())
 *   SIZES_ETH=0.003,0.01,0.03,0.1,0.3,1 \  # probe sizes; a token stops at its first failing size
 *   REPEATS=2 \                         # quotes per size
 *   MAX_ROUNDTRIP_LOSS_BPS=2500 \
 *   WRITE_REMOVE=1 REMOVE_MIN_LOSS_BPS=9000 \  # optional removal batch (see above)
 *   OUT_DIR=pool-sync-stage \
 *   npx ts-node -r tsconfig-paths/register src/scripts/swap-pool-sync.ts
 *
 * Env from ENV_FILE (default .env): UNISWAP_API_KEY, EVM_RPC_URL, BLOCKSCOUT_API_KEY.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { config } from 'dotenv';
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from 'viem';

import { fetchBlockscoutTokens } from './blockscout-tokens';

import {
  NATIVE,
  planFromTradingApi,
  tradingApiHops,
  type RouteHop,
  type RoutePlan,
} from '@/modules/vaults/index-vault/swap-route/multi-path-route';
import { UniswapTradingApiClient } from '@/modules/vaults/index-vault/swap-route/uniswap-trading-api.client';
import { EVM_PROTOCOL_VERSIONS, type EvmStack } from '@/modules/vaults/processing-tx/onchain/evm-protocol-versions';
import { guardedPoolOf, routePools, type GuardedPool } from '@/modules/vaults/processing-tx/onchain/evm-swap-guard';

const CHAIN_ID = 4663;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73' as Address;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address;
const HUBS = new Set<string>([NATIVE, WETH, USDG]);
const BATCH_SIZE = 40;

/** Owner Safe per stack; the adapter is the newest 4663 deployment of that stack in EVM_PROTOCOL_VERSIONS. */
const STACKS: Record<string, { stack: EvmStack; safe: Address }> = {
  stage: { stack: 'stage', safe: '0xcC3679a762F41C6f9727a6659bab519c3FbbF7c1' },
  mainnet: { stack: 'production', safe: '0x4733002467440E5881b84D19aC31e5c546Be9945' },
};

function currentSwapAdapter(stack: EvmStack): Address | null {
  const newest = (EVM_PROTOCOL_VERSIONS[CHAIN_ID] ?? [])
    .filter(v => v.stack === stack && v.swapAdapter)
    .sort((a, b) => b.version - a.version)[0];
  return newest?.swapAdapter ? lower(newest.swapAdapter) : null;
}

const ADAPTER_ABI = parseAbi([
  'function poolAllowed(bytes32) view returns (bool)',
  'function owner() view returns (address)',
  'function dailyCapBps() view returns (uint16)',
  'function setPoolsAllowed(bytes32[] poolIds, bool allowed)',
]);
const VAULT_ABI = parseAbi(['function custodyTokens() view returns (address[])']);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)']);

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

type TokenStatus = 'ok' | 'partial' | 'illiquid' | 'no_route';

interface TokenResult {
  address: Address;
  symbol: string;
  source: string[];
  status: TokenStatus;
  /** Largest size whose round trip passed, in ETH. */
  maxPassingEth: string | null;
  /** Round-trip loss per size tried, in bps (null: no route). */
  lossBps: Record<string, number | null>;
  failure?: string;
}

interface PoolSeen extends GuardedPool {
  /** Pool is on a route that passed (it must stay or be added). */
  keep: boolean;
  tokens: Set<string>;
  allowed?: boolean;
}

async function topTokens(n: number, apiKey: string | undefined): Promise<Address[]> {
  if (n <= 0) return [];
  if (!apiKey) throw new Error('TOP_N needs BLOCKSCOUT_API_KEY (or set TOP_N=0)');
  const tokens = await fetchBlockscoutTokens(apiKey, { max: n });
  return tokens.map(t => lower(t.address));
}

function tokensFromFile(path: string): Address[] {
  const text = readFileSync(path, 'utf8');
  try {
    const json = JSON.parse(text) as { tokens?: string[] } | string[];
    const arr = Array.isArray(json) ? json : (json.tokens ?? []);
    return arr.filter(isAddress).map(lower);
  } catch {
    return text.split(/\s+/).filter(isAddress).map(lower);
  }
}

function safeBatch(
  swapper: Address,
  safe: Address,
  ids: Hex[],
  allowed: boolean,
  name: string,
  description: string
): unknown {
  const transactions = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    transactions.push({
      to: swapper,
      value: '0',
      data: encodeFunctionData({
        abi: ADAPTER_ABI,
        functionName: 'setPoolsAllowed',
        args: [ids.slice(i, i + BATCH_SIZE), allowed],
      }),
      contractMethod: null,
      contractInputsValues: null,
    });
  }
  return {
    version: '1.0',
    chainId: String(CHAIN_ID),
    createdAt: Date.now(),
    meta: {
      name,
      description,
      txBuilderVersion: '2.1.0',
      createdFromSafeAddress: safe,
      createdFromOwnerAddress: '',
    },
    transactions,
  };
}

async function main(): Promise<void> {
  config({ path: process.env.ENV_FILE || '.env', quiet: true });

  const stackName = process.env.STACK ?? 'stage';
  const stack = STACKS[stackName];
  if (!stack) throw new Error(`STACK must be one of ${Object.keys(STACKS).join(', ')}`);
  const configured = process.env.SWAPPER ? lower(process.env.SWAPPER) : currentSwapAdapter(stack.stack);
  if (!configured) throw new Error(`no swap adapter for ${stackName} in EVM_PROTOCOL_VERSIONS; set SWAPPER`);
  const swapper = configured;
  const safe = lower(process.env.SAFE ?? stack.safe);
  const rpc = process.env.EVM_RPC_URL ?? process.env.ROBINHOOD_RPC_URL;
  if (!rpc) throw new Error('EVM_RPC_URL is required');

  // Typed loosely, like EvmContractReader.publicClient: viem's chain-less generics reject plain reads.
  const client = createPublicClient({ transport: http(rpc, { batch: true, retryCount: 3 }) }) as unknown as {
    getChainId(): Promise<number>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract(args: any): Promise<unknown>;
  };
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`EVM_RPC_URL is chain ${chainId}, expected ${CHAIN_ID}`);
  const newAdapter = process.env.NEW_ADAPTER === '1';
  if (!newAdapter) {
    await client.readContract({ address: swapper, abi: ADAPTER_ABI, functionName: 'dailyCapBps' }).catch(() => {
      throw new Error(
        `${swapper} is not a guarded swap adapter (no dailyCapBps); it has no pool allowlist. ` +
          `For an adapter that is not deployed yet, run with NEW_ADAPTER=1.`
      );
    });
    const owner = lower(
      String(await client.readContract({ address: swapper, abi: ADAPTER_ABI, functionName: 'owner' }))
    );
    if (owner !== safe) log(`WARNING: adapter ${swapper} is owned by ${owner}, not SAFE ${safe}`);
  }

  const api = new UniswapTradingApiClient({ get: (k: string) => process.env[k] } as never);
  if (!api.enabled) throw new Error('UNISWAP_API_KEY is required');

  // ---- token list ---------------------------------------------------------
  const sources = new Map<Address, Set<string>>();
  const addTokens = (tokens: Address[], source: string): void => {
    for (const t of tokens) {
      if (HUBS.has(t)) continue;
      const s = sources.get(t) ?? new Set<string>();
      s.add(source);
      sources.set(t, s);
    }
  };
  addTokens(await topTokens(Number(process.env.TOP_N ?? 500), process.env.BLOCKSCOUT_API_KEY), 'blockscout');
  addTokens(list(process.env.TOKENS).filter(isAddress).map(lower), 'TOKENS');
  for (const f of list(process.env.TOKENS_FILE)) addTokens(tokensFromFile(f), `file:${f}`);
  for (const v of list(process.env.VAULTS).filter(isAddress)) {
    const held = (await client.readContract({
      address: lower(v),
      abi: VAULT_ABI,
      functionName: 'custodyTokens',
    })) as Address[];
    addTokens(held.map(lower), `vault:${lower(v)}`);
  }
  const tokens = [...sources.keys()];

  const sizes = (
    list(process.env.SIZES_ETH).length ? list(process.env.SIZES_ETH) : ['0.003', '0.01', '0.03', '0.1', '0.3', '1']
  ).sort((a, b) => Number(a) - Number(b));
  const repeats = Math.max(1, Number(process.env.REPEATS ?? 2));
  const maxLossBps = Number(process.env.MAX_ROUNDTRIP_LOSS_BPS ?? 2500);
  log(
    `${tokens.length} tokens × sizes [${sizes.join(', ')}] ETH × ${repeats} repeat(s); ` +
      `loss limit ${maxLossBps} bps; adapter ${swapper}`
  );

  // ---- quotes -------------------------------------------------------------
  const pools = new Map<string, PoolSeen>();
  const seePools = (hops: RouteHop[] | GuardedPool[], token: Address, keep: boolean): void => {
    for (const h of hops) {
      const p = 'id' in h ? h : guardedPoolOf(h);
      const seen = pools.get(p.id) ?? { ...p, keep: false, tokens: new Set<string>() };
      seen.keep ||= keep;
      seen.tokens.add(token);
      pools.set(p.id, seen);
    }
  };
  /** Plan of the route (null: no route), plus every hop Uniswap considered. */
  const quote = async (
    tokenIn: Address,
    tokenOut: Address,
    amount: bigint
  ): Promise<{ plan: RoutePlan | null; hops: RouteHop[]; reason?: string }> => {
    const resp = await api.quoteExactInput(tokenIn, tokenOut, amount, swapper);
    if ('noRoute' in resp) return { plan: null, hops: [], reason: `no route (${resp.detail})` };
    const hops = tradingApiHops(resp, WETH);
    try {
      return { plan: planFromTradingApi(resp, tokenIn, tokenOut, amount, WETH), hops };
    } catch (err) {
      return { plan: null, hops, reason: (err as Error & { reason?: string }).reason ?? (err as Error).message };
    }
  };

  const results: TokenResult[] = [];
  for (const [i, token] of tokens.entries()) {
    const symbol = String(
      await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?')
    );
    const r: TokenResult = {
      address: token,
      symbol,
      source: [...(sources.get(token) ?? [])],
      status: 'no_route',
      maxPassingEth: null,
      lossBps: {},
    };
    for (const sizeEth of sizes) {
      const size = parseEther(sizeEth);
      let worst: number | null = 0;
      const passing: RoutePlan[] = [];
      for (let k = 0; k < repeats && worst !== null; k++) {
        try {
          const buy = await quote(NATIVE, token, size);
          seePools(buy.hops, token, false);
          if (!buy.plan || buy.plan.amountOut === 0n) {
            worst = null;
            r.failure = `buy: ${buy.reason ?? 'zero output'}`;
            break;
          }
          const sell = await quote(token, NATIVE, buy.plan.amountOut);
          seePools(sell.hops, token, false);
          if (!sell.plan) {
            worst = null;
            r.failure = `sell: ${sell.reason ?? 'zero output'}`;
            break;
          }
          const loss = sell.plan.amountOut >= size ? 0 : Number(((size - sell.plan.amountOut) * 10_000n) / size);
          worst = Math.max(worst, loss);
          passing.push(buy.plan, sell.plan);
        } catch (err) {
          worst = null;
          r.failure = `Trading API: ${(err as Error).message.split('\n')[0]}`;
        }
      }
      r.lossBps[sizeEth] = worst;
      if (worst === null || worst > maxLossBps) {
        if (worst !== null) r.failure = `round trip at ${sizeEth} ETH loses ${(worst / 100).toFixed(1)}%`;
        break; // larger sizes only lose more
      }
      r.maxPassingEth = sizeEth;
      for (const plan of passing) seePools(routePools(plan), token, true);
    }
    r.status =
      r.maxPassingEth === sizes[sizes.length - 1]
        ? 'ok'
        : r.maxPassingEth
          ? 'partial'
          : Object.values(r.lossBps).some(v => v !== null)
            ? 'illiquid'
            : 'no_route';
    if (r.status === 'ok') delete r.failure;
    results.push(r);
    log(
      `[${i + 1}/${tokens.length}] ${symbol.padEnd(12)} ${r.status.padEnd(8)} ` +
        `up to ${r.maxPassingEth ?? '-'} ETH${r.failure ? `  (${r.failure})` : ''}`
    );
  }

  // ---- on-chain state -----------------------------------------------------
  const all = [...pools.values()];
  log(
    newAdapter
      ? `NEW_ADAPTER: ${all.length} pools, none allowlisted yet`
      : `reading poolAllowed for ${all.length} pools…`
  );
  for (let i = 0; i < (newAdapter ? 0 : all.length); i += 50) {
    const chunk = all.slice(i, i + 50);
    const answers = await Promise.all(
      chunk.map(p =>
        client.readContract({ address: swapper, abi: ADAPTER_ABI, functionName: 'poolAllowed', args: [p.id] })
      )
    );
    chunk.forEach((p, k) => (p.allowed = answers[k] === true));
  }

  // A pool is proposed for removal only when it serves nothing worth keeping: every non-hub token
  // in it was checked this run, has no route or loses at least REMOVE_MIN_LOSS_BPS even at the
  // smallest size, and is not held by any of VAULTS (removing it would trap that vault's balance).
  const removeMinLossBps = Number(process.env.REMOVE_MIN_LOSS_BPS ?? 9000);
  const byToken = new Map(results.map(r => [r.address as string, r]));
  const held = new Set(results.filter(r => r.source.some(x => x.startsWith('vault:'))).map(r => r.address as string));
  const dead = (t: string): boolean => {
    const r = byToken.get(t);
    if (!r || r.maxPassingEth || held.has(t)) return false;
    const first = r.lossBps[sizes[0]];
    return first === null || first === undefined || first >= removeMinLossBps;
  };
  const toAdd = all.filter(p => p.keep && !p.allowed);
  const toRemove = all.filter(p => {
    if (!p.allowed || p.keep) return false;
    const nonHub = [p.token0, p.token1].filter(t => !HUBS.has(t));
    if (nonHub.length === 0) return false; // ETH/USDG-type hub pool: keep
    return nonHub.every(dead);
  });
  const writeRemove = process.env.WRITE_REMOVE === '1';

  // ---- output -------------------------------------------------------------
  const outDir = process.env.OUT_DIR ?? `pool-sync-${stackName}-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(outDir, { recursive: true });
  const symbols = new Map<string, string>([
    [NATIVE, 'ETH'],
    ...results.map(r => [r.address as string, r.symbol] as [string, string]),
  ]);
  for (const t of new Set(all.flatMap(p => [p.token0, p.token1]))) {
    if (symbols.has(t)) continue;
    const sym = await client.readContract({ address: t, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null);
    if (sym) symbols.set(t, String(sym));
  }
  const poolJson = (p: PoolSeen): unknown => ({
    id: p.id,
    venue: p.venue,
    pair: `${symbols.get(p.token0) ?? p.token0}/${symbols.get(p.token1) ?? p.token1}`,
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickSpacing: p.tickSpacing,
    allowed: p.allowed,
    onPassingRoute: p.keep,
    tokens: [...p.tokens].map(t => symbols.get(t) ?? t),
  });
  const counts = results.reduce<Record<string, number>>((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        stack: stackName,
        swapper,
        safe,
        generatedAt: new Date().toISOString(),
        settings: { sizesEth: sizes, repeats, maxRoundTripLossBps: maxLossBps, removeMinLossBps },
        summary: { tokens: counts, pools: all.length, toAdd: toAdd.length, toRemove: toRemove.length },
        add: toAdd.map(poolJson),
        remove: toRemove.map(poolJson),
        tokens: results,
        pools: all.map(poolJson),
      },
      null,
      2
    ) + '\n'
  );
  const today = new Date().toISOString().slice(0, 10);
  if (newAdapter) {
    writeFileSync(
      join(outDir, 'pools.json'),
      JSON.stringify(
        { chainId: CHAIN_ID, swapper, maxRoundTripLossBps: Number(maxLossBps), ids: toAdd.map(p => p.id) },
        null,
        1
      ) + '\n'
    );
  } else if (toAdd.length) {
    writeFileSync(
      join(outDir, 'safe-add.json'),
      JSON.stringify(
        safeBatch(
          swapper,
          safe,
          toAdd.map(p => p.id),
          true,
          `Guarded swap: allow ${toAdd.length} pools (${stackName}, ${today})`,
          `setPoolsAllowed(ids, true) on ${swapper}; pools of routes whose ETH round trip loses at most ${maxLossBps / 100}%`
        ),
        null,
        2
      ) + '\n'
    );
  }
  if (toRemove.length && writeRemove) {
    writeFileSync(
      join(outDir, 'safe-remove.json'),
      JSON.stringify(
        safeBatch(
          swapper,
          safe,
          toRemove.map(p => p.id),
          false,
          `Guarded swap: remove ${toRemove.length} pools (${stackName}, ${today})`,
          `setPoolsAllowed(ids, false) on ${swapper}; pools whose tokens have no route or lose >= ${removeMinLossBps / 100}% at ${sizes[0]} ETH`
        ),
        null,
        2
      ) + '\n'
    );
  }

  log(
    `\ntokens: ${JSON.stringify(counts)}\npools seen: ${all.length}, ` +
      `to add: ${toAdd.length}, to remove: ${toRemove.length}\nwritten to ${outDir}/ ` +
      `(${[newAdapter ? 'pools.json' : toAdd.length && 'safe-add.json', toRemove.length && writeRemove && 'safe-remove.json', 'report.json'].filter(Boolean).join(', ')})`
  );
  if (toRemove.length && !writeRemove) {
    log('removal candidates are listed in report.json `remove`; re-run with WRITE_REMOVE=1 to write safe-remove.json');
  }
}

main().catch(err => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
