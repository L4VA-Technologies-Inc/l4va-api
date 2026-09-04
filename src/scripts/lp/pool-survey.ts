/**
 * Survey existing Uniswap liquidity on Robinhood Chain to settle the
 * V3-vs-V4 question empirically rather than by feature list.
 *
 * Rob asked about v4 on the 01.09 call, but the mechanic he described — adding
 * one-sided L4VA between 4c and 5c so it fills as the price rises — is a
 * concentrated-liquidity range order, which v3 and v4 both support. So the
 * version choice should be decided by where trading actually routes on 4663,
 * not by that feature.
 *
 * This reads live pool state for reference pairs under each protocol and prints
 * their liquidity side by side. Read-only: it never builds or sends a
 * transaction.
 *
 * Usage:
 *   UNISWAP_API_KEY=... npx ts-node src/scripts/lp/pool-survey.ts
 *   UNISWAP_API_KEY=... npx ts-node src/scripts/lp/pool-survey.ts 0xTokenA 0xTokenB
 */

import { lpFetch, NATIVE_ETH, ROBINHOOD_CHAIN_ID, requireAddress } from './shared';

type Protocol = 'V2' | 'V3' | 'V4';

interface PoolInformation {
  poolReferenceIdentifier?: string;
  poolProtocol?: string;
  tokenAddressA?: string;
  tokenAddressB?: string;
  tickSpacing?: number;
  fee?: number;
  hookAddress?: string;
  chainId?: number;
  poolLiquidity?: string;
  sqrtRatioX96?: string;
  currentTick?: number;
  token0Reserves?: string;
  token1Reserves?: string;
}

async function surveyProtocol(
  protocol: Protocol,
  tokenAddressA?: string,
  tokenAddressB?: string
): Promise<PoolInformation[]> {
  const body: Record<string, unknown> = { protocol, chainId: ROBINHOOD_CHAIN_ID, pageSize: 25 };

  if (tokenAddressA && tokenAddressB) {
    body.poolParameters = { tokenAddressA, tokenAddressB };
  }

  try {
    const res = await lpFetch<{ pools: PoolInformation[] }>('/lp/pool_info', body);
    return res.pools ?? [];
  } catch (err) {
    console.warn(`  ${protocol}: ${(err as Error).message}`);
    return [];
  }
}

function describe(p: PoolInformation): string {
  const parts = [
    `protocol=${p.poolProtocol ?? '?'}`,
    `fee=${p.fee ?? '?'}`,
    `tickSpacing=${p.tickSpacing ?? '?'}`,
    `liquidity=${p.poolLiquidity ?? '0'}`,
  ];
  if (p.hookAddress && p.hookAddress !== '0x0000000000000000000000000000000000000000') {
    parts.push(`hook=${p.hookAddress}`);
  }
  if (p.poolReferenceIdentifier) parts.push(`ref=${p.poolReferenceIdentifier}`);
  return parts.join('  ');
}

function totalLiquidity(pools: PoolInformation[]): bigint {
  return pools.reduce((sum, p) => {
    try {
      return sum + BigInt(p.poolLiquidity ?? '0');
    } catch {
      return sum;
    }
  }, 0n);
}

async function main() {
  const [argA, argB] = process.argv.slice(2);

  let tokenA: string | undefined;
  let tokenB: string | undefined;
  if (argA && argB) {
    tokenA = requireAddress(argA, 'tokenA');
    tokenB = requireAddress(argB, 'tokenB');
  }

  console.log('=== Uniswap pool survey — Robinhood Chain (4663) ===');
  console.log(
    tokenA && tokenB
      ? `Pair: ${tokenA} / ${tokenB}`
      : 'No pair given — listing whatever the API returns per protocol.\n' +
          `(Tip: pass a pair, e.g. native ETH ${NATIVE_ETH} and a known RWA token,\n` +
          ' to compare depth for the pairing you actually care about.)'
  );
  console.log('');

  const results: Record<Protocol, PoolInformation[]> = { V2: [], V3: [], V4: [] };

  for (const protocol of ['V2', 'V3', 'V4'] as Protocol[]) {
    console.log(`--- ${protocol} ---`);
    const pools = await surveyProtocol(protocol, tokenA, tokenB);
    results[protocol] = pools;

    if (pools.length === 0) {
      console.log('  (no pools returned)');
    } else {
      for (const p of pools.slice(0, 10)) console.log(`  ${describe(p)}`);
      if (pools.length > 10) console.log(`  ... and ${pools.length - 10} more`);
    }
    console.log('');
  }

  console.log('=== Summary ===');
  for (const protocol of ['V2', 'V3', 'V4'] as Protocol[]) {
    const pools = results[protocol];
    console.log(
      `${protocol}: ${pools.length} pool(s), total liquidity ${totalLiquidity(pools).toString()}`
    );
  }

  console.log('');
  console.log('Decision guidance:');
  console.log('  • Put the TGE pool where trading actually routes — fragmenting away from');
  console.log('    the dominant version costs more than any feature difference here.');
  console.log('  • v4 is only strictly needed for hooks (not required for a launch pool)');
  console.log('    and native-ETH pairing without WETH.');
  console.log('  • Rob\'s one-sided range-order plan works on v3 and v4 alike.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
