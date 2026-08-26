import fs from 'fs';
import path from 'path';

import fetch from 'node-fetch';

const outDir = path.resolve(__dirname, '..', 'data', 'demo-assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const ANVIL_API_URL = 'https://prod.api.ada-anvil.app/v2';
const ANVIL_API_KEY = '';
const COINGECKO_API_URL = 'https://api.coingecko.com/api';
const COINGECKO_API_KEY = '';
const DEXHUNTER_BASE = 'https://api-us.dexhunterv3.app';
const DEXHUNTER_KEY = '';

async function fetchAnvilRobinhoodAssets() {
  try {
    const url = `${ANVIL_API_URL.replace(/\/$/, '')}/services/marketplace/collections/top?limit=200`;
    const res = await fetch(url, { headers: { 'x-api-key': ANVIL_API_KEY } });
    if (!res.ok) throw new Error(`Anvil error ${res.status}`);
    const body = await res.json();
    // flatten to useful fields
    const items = Array.isArray(body) ? body : body.results || [];
    const mapped = items.map((c: any) => ({
      policy: c.policy || c.contractAddress || null,
      name: c.name,
      logo: c.logo || c.image || null,
      listings: c.listings || c.volume || 0,
    }));
    fs.writeFileSync(path.join(outDir, 'wayup-top-collections.json'), JSON.stringify(mapped, null, 2));
    console.log('Wrote wayup-top-collections.json');
  } catch (err) {
    console.error('Anvil fetch failed:', err.message || err);
  }
}

async function fetchCoinGeckoMemes() {
  try {
    const url = `${COINGECKO_API_URL.replace(/\/$/, '')}/v3/coins/markets?vs_currency=usd&category=meme-token&order=market_cap_desc&per_page=100&page=1&sparkline=false`;
    const res = await fetch(url, { headers: { 'x-cg-demo-api-key': COINGECKO_API_KEY } });
    if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
    const body = await res.json();
    const mapped = body.map((c: any) => ({ id: c.id, symbol: c.symbol, name: c.name, image: c.image }));
    fs.writeFileSync(path.join(outDir, 'coingecko-memecoins.json'), JSON.stringify(mapped, null, 2));
    console.log('Wrote coingecko-memecoins.json');
  } catch (err) {
    console.error('CoinGecko fetch failed:', err.message || err);
  }
}

async function fetchDexHunterTokens() {
  try {
    const url = `${DEXHUNTER_BASE.replace(/\/$/, '')}/swap/tokens`;
    const res = await fetch(url, { headers: { 'X-Partner-Id': DEXHUNTER_KEY } });
    if (!res.ok) throw new Error(`DexHunter error ${res.status}`);
    const body = await res.json();
    fs.writeFileSync(path.join(outDir, 'dexhunter-tokens.json'), JSON.stringify(body, null, 2));
    console.log('Wrote dexhunter-tokens.json');
  } catch (err) {
    console.error('DexHunter fetch failed:', err.message || err);
  }
}

async function main() {
  await fetchAnvilRobinhoodAssets();
  await fetchCoinGeckoMemes();
  await fetchDexHunterTokens();
  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
