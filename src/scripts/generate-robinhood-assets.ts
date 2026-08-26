/**
 * Generate Robinhood-chain demo asset seeds:
 *   - robinhood-rwas.json
 *   - robinhood-memecoins.json
 *   - robinhood-nfts.json
 *
 * Fixes applied vs previous version (see chat-gpt-tokens.txt):
 *   - Robinhood field names: tokenSymbol / tokenName / logoUrl / currentMultiplier / tokenDecimals
 *   - Robinhood request headers (Accept + User-Agent)
 *   - Blockscout v2 cursor pagination (next_page_params), not page=
 *   - DexScreener /tokens/v1/robinhood/{addresses} (keep 0x)
 *   - Best pair by liquidity; score uses volume.h24 + liquidity.usd
 *   - Exclude official RWA contracts + WETH + USDG from memecoin list
 */
import fs from 'fs';
import path from 'path';

const outDir = path.resolve(__dirname, '..', 'data', 'demo-assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const ROBINHOOD_ASSETS_API = process.env.ROBINHOOD_ASSETS_API || 'https://api.robinhood.com/rhj/assets';
const BLOCKSCOUT_BASE = process.env.BLOCKSCOUT_BASE || 'https://robinhoodchain.blockscout.com';
const DEXSCREENER_BASE = process.env.DEXSCREENER_BASE || 'https://api.dexscreener.com';
const RH_CHAIN_ID = 4663;
const DEXSCREENER_CHAIN = process.env.DEXSCREENER_CHAIN || 'robinhood';

/** Canonical Robinhood WETH + USDG — never treat as memecoins */
const EXCLUDED_CONTRACTS = new Set([
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
]);

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0',
};

function writeJson(filename: string, data: unknown) {
  const filePath = path.join(outDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${filename} — ${Array.isArray(data) ? data.length : 1} items`);
}

function blockscoutAddress(token: any): string | null {
  return token.address ?? token.address_hash ?? null;
}

function blockscoutHolders(token: any): number {
  return Number(token.holders ?? token.holders_count ?? 0);
}

type RwaSeed = {
  id: string | null;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  decimals: number | null;
  multiplier: number | null;
  contract: string | null;
};

async function fetchJson(url: string, label: string, retries = 5): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Referer: `${BLOCKSCOUT_BASE}/tokens`,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const waitMs = Math.min(15000, 1500 * 2 ** (attempt - 1));
      console.warn(`${label} attempt ${attempt}/${retries} failed: ${lastError.message}`);
      if (attempt < retries) {
        console.warn(`  retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  // Last resort: curl often succeeds when Node fetch gets intermittent 500s from Blockscout
  try {
    console.warn(`${label}: falling back to curl`);
    const { execFileSync } = await import('child_process');
    const out = execFileSync('curl', ['-sS', '-H', 'Accept: application/json', '-H', 'User-Agent: Mozilla/5.0', url], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60000,
    });
    return JSON.parse(out);
  } catch (curlErr: any) {
    throw lastError ?? new Error(`${label} failed (${curlErr.message})`);
  }
}

async function fetchRobinhoodRWAs(): Promise<RwaSeed[]> {
  const body: any = await fetchJson(ROBINHOOD_ASSETS_API, 'Robinhood');
  const items: any[] = Array.isArray(body) ? body : (body.assets ?? body.results ?? []);

  const mapped: RwaSeed[] = items
    .filter(
      (a: any) =>
        a.status === 'ASSET_STATUS_ACTIVE' &&
        Array.isArray(a.deployments) &&
        a.deployments.some((d: any) => Number(d.chainId) === RH_CHAIN_ID)
    )
    .map((a: any) => {
      const deployment = a.deployments.find((d: any) => Number(d.chainId) === RH_CHAIN_ID);
      return {
        id: a.id ?? null,
        symbol: a.tokenSymbol ?? a.symbol ?? null,
        name: a.tokenName ?? a.name ?? null,
        logo: a.logoUrl ?? a.logo ?? null,
        decimals: a.tokenDecimals ?? null,
        multiplier: a.currentMultiplier ?? null,
        contract: deployment?.contractAddress ?? null,
      };
    })
    .filter((a: RwaSeed) => !!a.contract);

  writeJson('robinhood-rwas.json', mapped);
  return mapped;
}

async function fetchBlockscoutTokens(type: string, maxItems = 2000): Promise<any[]> {
  const results: any[] = [];
  let params = new URLSearchParams({ type });

  while (results.length < maxItems) {
    const url = `${BLOCKSCOUT_BASE}/api/v2/tokens?${params.toString()}`;
    let body: any;
    try {
      body = await fetchJson(url, 'Blockscout');
    } catch (err: any) {
      console.warn(`Blockscout pagination stopped early with ${results.length} items: ${err.message}`);
      break;
    }
    const items: any[] = Array.isArray(body) ? body : (body.items ?? []);
    results.push(...items);

    if (!body.next_page_params || items.length === 0 || results.length >= maxItems) {
      break;
    }

    params = new URLSearchParams({
      type,
      ...Object.fromEntries(Object.entries(body.next_page_params).map(([key, value]) => [key, String(value)])),
    });

    // Be polite to Blockscout — their API is flaky under load
    await new Promise(r => setTimeout(r, 800));
  }

  return results.slice(0, maxItems);
}

function chooseBestPair(pairs: any[], tokenAddress: string) {
  const target = tokenAddress.toLowerCase();
  return (
    pairs
      .filter(
        pair => pair.baseToken?.address?.toLowerCase() === target || pair.quoteToken?.address?.toLowerCase() === target
      )
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0] ?? null
  );
}

async function fetchDexScreenerPairs(addresses: string[]): Promise<Map<string, any>> {
  const byAddress = new Map<string, any>();
  if (addresses.length === 0) return byAddress;

  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const url = `${DEXSCREENER_BASE}/tokens/v1/${DEXSCREENER_CHAIN}/${batch.join(',')}`;

    try {
      const res = await fetch(url, { headers: DEFAULT_HEADERS });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`DexScreener batch failed ${res.status}: ${text.slice(0, 120)}`);
        continue;
      }

      const body: any = await res.json();
      const pairs: any[] = Array.isArray(body) ? body : (body.pairs ?? []);

      for (const address of batch) {
        const best = chooseBestPair(pairs, address);
        if (best) byAddress.set(address.toLowerCase(), best);
      }
    } catch (err: any) {
      console.warn('DexScreener request error:', err.message || err);
    }
  }

  return byAddress;
}

function isRobinhoodRwaToken(token: { name?: string | null; symbol?: string | null }) {
  const name = token.name || '';
  // Official stock tokens on RH chain look like "NVIDIA • Robinhood Token"
  return /robinhood\s*token/i.test(name) || /•\s*Robinhood/i.test(name);
}

async function fetchRobinhoodMemecoins(rwaContracts: Set<string>, erc20Tokens: any[]) {
  const candidates = erc20Tokens
    .map((t: any) => {
      const address = blockscoutAddress(t);
      return {
        address: address ? address.toLowerCase() : null,
        name: t.name ?? t.symbol ?? null,
        symbol: t.symbol ?? null,
        holders_count: blockscoutHolders(t),
        total_supply: t.total_supply ?? null,
        icon_url: t.icon_url ?? null,
      };
    })
    .filter((t: any) => {
      if (!t.address || t.holders_count <= 0) return false;
      if (EXCLUDED_CONTRACTS.has(t.address)) return false;
      if (rwaContracts.has(t.address)) return false;
      if (isRobinhoodRwaToken(t)) return false;
      if (/^(WETH|USDC|USDT|USDG|DAI|TETHER)$/i.test(t.symbol || '')) return false;
      return true;
    });

  console.log(`Memecoin candidates after RWA/infra filter: ${candidates.length}`);

  const addresses = candidates.map((t: any) => t.address);
  const dexByAddress = await fetchDexScreenerPairs(addresses);

  const scored = candidates.map((t: any) => {
    const pair = dexByAddress.get(t.address) ?? null;
    const volume24h = Number(pair?.volume?.h24 ?? 0);
    const liquidityUsd = Number(pair?.liquidity?.usd ?? 0);
    const priceUsd = pair?.priceUsd != null ? Number(pair.priceUsd) : null;
    const priceChange24h = pair?.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null;
    const fdv = pair?.fdv != null ? Number(pair.fdv) : null;
    const marketCap = pair?.marketCap != null ? Number(pair.marketCap) : null;
    const holders = Number(t.holders_count ?? 0);

    const score = Math.log1p(volume24h) * 3 + Math.log1p(liquidityUsd) * 2 + Math.log1p(holders);

    return {
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      holders_count: holders,
      total_supply: t.total_supply,
      icon_url: t.icon_url,
      price_usd: priceUsd,
      volume_24h: volume24h || null,
      liquidity_usd: liquidityUsd || null,
      price_change_24h: priceChange24h,
      fdv,
      market_cap: marketCap,
      pair_address: pair?.pairAddress ?? null,
      dex_id: pair?.dexId ?? null,
      score,
    };
  });

  scored.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top100 = scored.slice(0, 100);
  writeJson('robinhood-memecoins.json', top100);
  return top100;
}

function buildRwasFromBlockscout(erc20Tokens: any[]): RwaSeed[] {
  return erc20Tokens
    .map((t: any) => {
      const address = blockscoutAddress(t);
      return {
        id: null,
        symbol: t.symbol ?? null,
        name: t.name ?? null,
        logo: t.icon_url ?? null,
        decimals: t.decimals != null ? Number(t.decimals) : null,
        multiplier: null,
        contract: address ? address.toLowerCase() : null,
      } as RwaSeed;
    })
    .filter(t => t.contract && isRobinhoodRwaToken(t));
}

async function fetchRobinhoodNFTs() {
  // Sequential — parallel dual-type fetch was flaky on this explorer
  const erc721 = await fetchBlockscoutTokens('ERC-721', 400);
  const erc1155 = await fetchBlockscoutTokens('ERC-1155', 200);
  const nfts = [...erc721, ...erc1155];

  const normalized = nfts.map((t: any) => ({
    address: blockscoutAddress(t),
    name: t.name ?? t.symbol ?? null,
    symbol: t.symbol ?? null,
    type: t.type ?? null,
    logo: t.icon_url ?? null,
    holders_count: blockscoutHolders(t),
    total_supply: t.total_supply ?? null,
  }));

  const top100 = normalized
    .filter(x => x.address && x.holders_count > 0)
    .sort((a, b) => b.holders_count - a.holders_count)
    .slice(0, 100)
    .map(x => ({
      ...x,
      address: x.address!.toLowerCase(),
    }));

  writeJson('robinhood-nfts.json', top100);
  return top100;
}

async function main() {
  console.log('Generating Robinhood demo assets...');

  console.log('Fetching ERC-20 tokens from Blockscout...');
  const erc20Tokens = await fetchBlockscoutTokens('ERC-20', 800);
  console.log(`Blockscout ERC-20 items: ${erc20Tokens.length}`);

  let rwas: RwaSeed[] = [];
  try {
    rwas = await fetchRobinhoodRWAs();
  } catch (err: any) {
    console.error('Robinhood /rhj/assets failed (often geo-blocked):', err.message || err);
    rwas = buildRwasFromBlockscout(erc20Tokens);
    writeJson('robinhood-rwas.json', rwas);
    console.log(`Fallback RWA list from Blockscout name heuristic: ${rwas.length}`);
  }

  const rwaContracts = new Set(rwas.map(x => x.contract?.toLowerCase()).filter((x): x is string => !!x));
  console.log(`RWA exclusion set: ${rwaContracts.size} contracts`);

  try {
    await fetchRobinhoodMemecoins(rwaContracts, erc20Tokens);
  } catch (err: any) {
    console.error('Robinhood memecoins generation failed:', err.message || err);
    writeJson('robinhood-memecoins.json', []);
  }

  try {
    await fetchRobinhoodNFTs();
  } catch (err: any) {
    console.error('Robinhood NFTs generation failed:', err.message || err);
    writeJson('robinhood-nfts.json', []);
  }

  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
