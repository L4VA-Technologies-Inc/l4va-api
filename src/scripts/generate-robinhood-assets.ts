import fs from 'fs';
import path from 'path';

import fetch from 'node-fetch';

const outDir = path.resolve(__dirname, '..', 'data', 'demo-assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const ROBINHOOD_ASSETS_API = process.env.ROBINHOOD_ASSETS_API || 'https://api.robinhood.com/rhj/assets';
const BLOCKSCOUT_BASE = process.env.BLOCKSCOUT_BASE || 'https://robinhoodchain.blockscout.com';
const DEXSCREENER_BASE = process.env.DEXSCREENER_BASE || 'https://api.dexscreener.com';

async function fetchRobinhoodRWAs() {
  try {
    const url = ROBINHOOD_ASSETS_API;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Robinhood assets error ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : body.results || body.assets || [];
    const filtered = items.filter(
      (a: any) =>
        a.status === 'ASSET_STATUS_ACTIVE' &&
        Array.isArray(a.deployments) &&
        a.deployments.some((d: any) => Number(d.chainId) === 4663)
    );
    const mapped = filtered.map((a: any) => {
      const rhDeployment = a.deployments.find((d: any) => Number(d.chainId) === 4663) || {};
      return {
        id: a.id || a.asset_id || null,
        symbol: a.symbol || a.ticker || null,
        name: a.name || null,
        logo: a.logo || a.image || null,
        multiplier: a.multiplier || rhDeployment.multiplier || null,
        contract: rhDeployment.contractAddress || rhDeployment.address || null,
        raw: a,
      };
    });
    fs.writeFileSync(path.join(outDir, 'robinhood-rwas.json'), JSON.stringify(mapped, null, 2));
    console.log('Wrote robinhood-rwas.json —', mapped.length, 'items');
  } catch (err: any) {
    console.error('Robinhood RWAs fetch failed:', err.message || err);
  }
}

async function fetchBlockscoutTokens(type = 'ERC-20', pageLimit = 10) {
  try {
    const results: any[] = [];
    for (let page = 1; page <= pageLimit; page++) {
      const url = `${BLOCKSCOUT_BASE}/api/v2/tokens?type=${encodeURIComponent(type)}&page=${page}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`Blockscout page ${page} returned ${res.status}`);
        break;
      }
      const body = await res.json();
      if (!Array.isArray(body) || body.length === 0) break;
      results.push(...body);
      // If the page returned fewer items than expected, assume end
      if (body.length < 100) break;
    }
    return results;
  } catch (err: any) {
    console.error('Blockscout tokens fetch failed:', err.message || err);
    return [];
  }
}

async function enrichWithDexscreener(addresses: string[]) {
  try {
    if (addresses.length === 0) return [];
    // Dexscreener rate limits and API surface vary; we batch up to 30
    const batches: string[][] = [];
    for (let i = 0; i < addresses.length; i += 30) batches.push(addresses.slice(i, i + 30));
    const enriched: any[] = [];
    for (const batch of batches) {
      const q = batch.map(a => a.replace(/^0x/i, '')).join(',');
      const url = `${DEXSCREENER_BASE}/latest/dex/tokens?addresses=${q}`; // best-effort endpoint
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn('DexScreener batch failed:', res.status);
          continue;
        }
        const body = await res.json();
        if (Array.isArray(body)) {
          enriched.push(...body);
        } else if (body.tokens) {
          enriched.push(...body.tokens);
        } else {
          enriched.push(body);
        }
      } catch (err: any) {
        console.warn('DexScreener request error:', err.message || err);
      }
    }
    return enriched;
  } catch (err: any) {
    console.error('DexScreener enrichment failed:', err.message || err);
    return [];
  }
}

async function fetchRobinhoodMemecoins() {
  try {
    // 1) Pull ERC-20 tokens from Blockscout
    const tokens = await fetchBlockscoutTokens('ERC-20', 20);
    // 2) Filter out known non-meme tokens (RWAs will be excluded later by contract)
    // Basic filters: drop tokens without an address, no holders, or obvious stable/WETH symbols
    const filtered = tokens.filter(
      (t: any) =>
        t.address_hash &&
        Number(t.holders_count || 0) > 0 &&
        !/^(WETH|USDC|USDT|DAI|TETHER|ROBIN|RHJ)/i.test(t.symbol || t.name || '')
    );
    const addresses = filtered.map((t: any) => t.address_hash);
    // 3) Enrich via DexScreener for liquidity/volume/marketcap
    const enriched = await enrichWithDexscreener(addresses);
    // 4) Combine Blockscout base info with dexscreener metrics when available
    const byAddr = new Map(filtered.map((t: any) => [t.address_hash.toLowerCase(), t]));
    const merged = enriched
      .map((e: any) => {
        const addr = (e.address || e.tokenAddress || e.pairAddress || '').toLowerCase();
        const base = byAddr.get(addr) || {};
        return {
          address: addr,
          name: base.name || e.name || e.symbol || null,
          symbol: base.symbol || e.symbol || null,
          holders_count: Number(base.holders_count || 0),
          dexscreener: e,
          raw: base,
        };
      })
      .concat(
        filtered
          .filter(
            (t: any) => !enriched.some((e: any) => (e.address || '').toLowerCase() === t.address_hash.toLowerCase())
          )
          .map((t: any) => ({
            address: t.address_hash.toLowerCase(),
            name: t.name,
            symbol: t.symbol,
            holders_count: Number(t.holders_count || 0),
            dexscreener: null,
            raw: t,
          }))
      );
    // 5) Heuristic select: tokens with some liquidity/volume or > X holders. Sort and take top 100.
    const withScore = merged.map((m: any) => {
      const vol = Number((m.dexscreener && (m.dexscreener.volume || m.dexscreener.usdVolume)) || 0);
      const liq = Number((m.dexscreener && (m.dexscreener.liquidity || m.dexscreener.tvl)) || 0);
      const holders = Number(m.holders_count || 0);
      const score = Math.log1p(vol) * 3 + Math.log1p(liq) * 2 + Math.log1p(holders);
      return { ...m, score };
    });
    withScore.sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
    const top100 = withScore.slice(0, 100);
    fs.writeFileSync(path.join(outDir, 'robinhood-memecoins.json'), JSON.stringify(top100, null, 2));
    console.log('Wrote robinhood-memecoins.json —', top100.length, 'items');
  } catch (err: any) {
    console.error('Robinhood memecoins generation failed:', err.message || err);
  }
}

async function fetchRobinhoodNFTs() {
  try {
    const nfts = await fetchBlockscoutTokens('ERC-721,ERC-1155', 20);
    // Normalize and sort by holders_count
    const normalized = nfts.map((t: any) => ({
      address: t.address_hash,
      name: t.name || t.contractName || t.symbol,
      holders_count: Number(t.holders_count || 0),
      raw: t,
    }));
    const filtered = normalized.filter((n: any) => n.address && n.holders_count > 0);
    filtered.sort((a: any, b: any) => b.holders_count - a.holders_count);
    const top100 = filtered.slice(0, 100);
    fs.writeFileSync(path.join(outDir, 'robinhood-nfts.json'), JSON.stringify(top100, null, 2));
    console.log('Wrote robinhood-nfts.json —', top100.length, 'items');
  } catch (err: any) {
    console.error('Robinhood NFTs generation failed:', err.message || err);
  }
}

async function main() {
  await fetchRobinhoodRWAs();
  await fetchRobinhoodMemecoins();
  await fetchRobinhoodNFTs();
  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
