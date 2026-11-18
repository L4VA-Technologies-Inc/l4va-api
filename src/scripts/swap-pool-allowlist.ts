/**
 * Pools the guarded swap adapter must allowlist so vaults (and the FeeConverter) can trade.
 *
 * Asks the Uniswap Trading API — the same source and the same route rules the API uses for
 * vault trades — for ETH → token and token → ETH routes at a few sizes, and prints every pool
 * those routes touch, with the id `GuardedUniversalRouterSwapAdapter.setPoolsAllowed` expects.
 * Read-only: it signs nothing. Paste `ids` into the Safe batch (setPoolsAllowed(ids, true)).
 *
 * Usage:
 *   ENV_FILE=.env.stage \             # needs UNISWAP_API_KEY, EVM_CHAIN_ID; optional EVM_WETH_ADDRESS
 *   SWAPPER=0x<guarded swap adapter>  # the address the routes are quoted for
 *   TOKENS=0xa,0xb \                  # optional; default INDEX_BASKET_ALLOWED_ASSETS + USDG
 *   SIZES_ETH=0.01,0.1,1 \            # optional probe sizes
 *   npx ts-node -r tsconfig-paths/register src/scripts/swap-pool-allowlist.ts > pools.json
 */
import { config } from 'dotenv';
import { parseEther, type Address } from 'viem';

import { planFromTradingApi, type RoutePlan } from '@/modules/vaults/index-vault/swap-route/multi-path-route';
import { UniswapTradingApiClient } from '@/modules/vaults/index-vault/swap-route/uniswap-trading-api.client';
import { routePools, type GuardedPool } from '@/modules/vaults/processing-tx/onchain/evm-swap-guard';

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const ROBINHOOD_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address;
const ROBINHOOD_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

async function main(): Promise<void> {
  config({ path: process.env.ENV_FILE || '.env', quiet: true });
  const swapper = process.env.SWAPPER as Address | undefined;
  if (!swapper) throw new Error('SWAPPER (the guarded swap adapter address) is required');
  const weth = (process.env.EVM_WETH_ADDRESS || ROBINHOOD_WETH) as Address;

  const api = new UniswapTradingApiClient({ get: (k: string) => process.env[k] } as never);
  const tokens = list(process.env.TOKENS).length
    ? list(process.env.TOKENS)
    : [...list(process.env.INDEX_BASKET_ALLOWED_ASSETS), ROBINHOOD_USDG];
  const sizes = (list(process.env.SIZES_ETH).length ? list(process.env.SIZES_ETH) : ['0.01', '0.1', '1']).map(s =>
    parseEther(s)
  );

  const pools = new Map<string, GuardedPool & { seenIn: string[] }>();
  const misses: string[] = [];
  const add = (plan: RoutePlan, label: string): void => {
    for (const p of routePools(plan)) {
      const seen = pools.get(p.id) ?? { ...p, seenIn: [] };
      if (!seen.seenIn.includes(label)) seen.seenIn.push(label);
      pools.set(p.id, seen);
    }
  };
  const quote = async (tokenIn: Address, tokenOut: Address, amount: bigint): Promise<RoutePlan | null> => {
    const resp = await api.quoteExactInput(tokenIn, tokenOut, amount, swapper);
    if ('noRoute' in resp) return null;
    return planFromTradingApi(resp, tokenIn, tokenOut, amount, weth);
  };

  for (const t of tokens.map(a => a.toLowerCase() as Address)) {
    for (const size of sizes) {
      const buy = await quote(NATIVE, t, size).catch(() => null);
      if (!buy) {
        misses.push(`ETH→${t} @ ${size}`);
        continue;
      }
      add(buy, `ETH→${t}`);
      const sell = await quote(t, NATIVE, buy.amountOut).catch(() => null);
      if (sell) add(sell, `${t}→ETH`);
      else misses.push(`${t}→ETH @ ${buy.amountOut}`);
    }
  }

  const out = [...pools.values()];
  process.stdout.write(
    JSON.stringify(
      {
        chainId: Number(process.env.EVM_CHAIN_ID ?? 4663),
        swapper,
        generatedAt: new Date().toISOString(),
        ids: out.map(p => p.id),
        pools: out,
        noRoute: misses,
      },
      null,
      2
    ) + '\n'
  );
}

main().catch(err => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
