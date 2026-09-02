/* eslint-disable no-console */
/**
 * Seed Robinhood tokens from JSON into the markets table.
 *
 * Idempotent: upserts by contract_address. Safe to re-run on dev/prod.
 *
 * Usage:
 *   npm run seed:robinhood-markets
 */
import * as fs from 'fs';
import * as path from 'path';

import { DataSource } from 'typeorm';

import { loadSecrets } from '../load-gcp-secrets';
import { MarketTokenKind, MarketType } from '../types/market.types';

type RhMemeSeed = {
  address: string;
  name: string | null;
  symbol: string | null;
  holders_count?: number;
  total_supply?: string | null;
  icon_url?: string | null;
  price_usd?: number | null;
  volume_24h?: number | null;
  liquidity_usd?: number | null;
  price_change_24h?: number | null;
  fdv?: number | null;
  market_cap?: number | null;
  pair_address?: string | null;
  dex_id?: string | null;
  score?: number | null;
};

type RhRwaSeed = {
  symbol: string | null;
  name: string | null;
  logo: string | null;
  decimals: number | null;
  contract: string | null;
};

type RhNftSeed = {
  address: string;
  name: string | null;
  symbol: string | null;
  logo?: string | null;
  holders_count?: number;
  total_supply?: string | null;
};

type MarketSeedRow = {
  type: MarketType;
  token_kind: MarketTokenKind;
  name: string | null;
  symbol: string | null;
  image_url: string | null;
  contract_address: string;
  pair_address: string | null;
  decimals: number | null;
  holders_count: number | null;
  dex_id: string | null;
  price_usd: number | null;
  fdv: number | null;
  volume_24h: number | null;
  liquidity_usd: number | null;
  score: number | null;
  circSupply: number;
  mcap: number;
  totalSupply: number;
  price_change_24h: number;
};

const NUMERIC_20_8_MAX = 1e12;
const PRICE_CHANGE_MAX = 1e4;
const SCORE_MAX = 1e8;

function resolveSeedPath(filename: string): string {
  const candidates = [
    path.join(__dirname, '../data/demo-assets', filename),
    path.join(__dirname, '../../data/demo-assets', filename),
    path.join(process.cwd(), 'src/data/demo-assets', filename),
    path.join(process.cwd(), 'dist/data/demo-assets', filename),
  ];
  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) {
    throw new Error(`${filename} not found. Looked in:\n${candidates.join('\n')}`);
  }
  return filePath;
}

function loadJson<T>(filename: string): T {
  const filePath = resolveSeedPath(filename);
  console.log(`Loading ${filename} from ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function toNum(value: unknown, maxAbs: number = NUMERIC_20_8_MAX): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) >= maxAbs) return null;
  return n;
}

function toInt(value: unknown, maxAbs: number = 2_147_483_647): number | null {
  const n = toNum(value, maxAbs);
  if (n == null) return null;
  return Math.trunc(n);
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function mapMemes(seed: RhMemeSeed[]): MarketSeedRow[] {
  return seed
    .map(item => {
      const contract_address = normalizeAddress(item.address);
      if (!contract_address) return null;
      const mcap = toNum(item.market_cap) ?? 0;
      const totalSupply = toNum(item.total_supply) ?? 0;
      return {
        type: MarketType.robinhood_token,
        token_kind: MarketTokenKind.memecoin,
        name: item.name,
        symbol: item.symbol,
        image_url: item.icon_url ?? null,
        contract_address,
        pair_address: normalizeAddress(item.pair_address),
        decimals: null,
        holders_count: toInt(item.holders_count),
        dex_id: item.dex_id ?? null,
        price_usd: toNum(item.price_usd),
        fdv: toNum(item.fdv),
        volume_24h: toNum(item.volume_24h),
        liquidity_usd: toNum(item.liquidity_usd),
        score: toNum(item.score, SCORE_MAX),
        circSupply: 0,
        mcap,
        totalSupply,
        price_change_24h: toNum(item.price_change_24h, PRICE_CHANGE_MAX) ?? 0,
      };
    })
    .filter((row): row is MarketSeedRow => row != null);
}

function mapRwas(seed: RhRwaSeed[]): MarketSeedRow[] {
  return seed
    .map(item => {
      const contract_address = normalizeAddress(item.contract);
      if (!contract_address) return null;
      return {
        type: MarketType.robinhood_token,
        token_kind: MarketTokenKind.rwa,
        name: item.name,
        symbol: item.symbol,
        image_url: item.logo,
        contract_address,
        pair_address: null,
        decimals: toInt(item.decimals, 32_767),
        holders_count: null,
        dex_id: null,
        price_usd: null,
        fdv: null,
        volume_24h: null,
        liquidity_usd: null,
        score: null,
        circSupply: 0,
        mcap: 0,
        totalSupply: 0,
        price_change_24h: 0,
      };
    })
    .filter((row): row is MarketSeedRow => row != null);
}

function mapNfts(seed: RhNftSeed[]): MarketSeedRow[] {
  return seed
    .map(item => {
      const contract_address = normalizeAddress(item.address);
      if (!contract_address) return null;
      return {
        type: MarketType.robinhood_token,
        token_kind: MarketTokenKind.nft,
        name: item.name,
        symbol: item.symbol,
        image_url: item.logo ?? null,
        contract_address,
        pair_address: null,
        decimals: null,
        holders_count: toInt(item.holders_count),
        dex_id: null,
        price_usd: null,
        fdv: null,
        volume_24h: null,
        liquidity_usd: null,
        score: null,
        circSupply: 0,
        mcap: 0,
        totalSupply: toNum(item.total_supply) ?? 0,
        price_change_24h: 0,
      };
    })
    .filter((row): row is MarketSeedRow => row != null);
}

async function upsertRows(
  executor: { query: (sql: string, parameters?: unknown[]) => Promise<unknown> },
  rows: MarketSeedRow[]
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  const addresses = rows.map(r => r.contract_address);
  const existing = (await executor.query(
    `SELECT contract_address FROM markets WHERE type = $1 AND contract_address = ANY($2)`,
    [MarketType.robinhood_token, addresses]
  )) as Array<{ contract_address: string }>;
  const existingSet = new Set(existing.map(r => r.contract_address));

  for (const row of rows) {
    await executor.query(
      `
      INSERT INTO markets (
        type, token_kind, name, symbol, image_url, contract_address, pair_address,
        decimals, holders_count, dex_id, price_usd, fdv, volume_24h, liquidity_usd, score,
        "circSupply", mcap, "totalSupply", price_change_24h, vault_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, NULL
      )
      ON CONFLICT (contract_address) WHERE (contract_address IS NOT NULL)
      DO UPDATE SET
        type = EXCLUDED.type,
        token_kind = EXCLUDED.token_kind,
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        image_url = EXCLUDED.image_url,
        pair_address = EXCLUDED.pair_address,
        decimals = EXCLUDED.decimals,
        holders_count = EXCLUDED.holders_count,
        dex_id = EXCLUDED.dex_id,
        price_usd = EXCLUDED.price_usd,
        fdv = EXCLUDED.fdv,
        volume_24h = EXCLUDED.volume_24h,
        liquidity_usd = EXCLUDED.liquidity_usd,
        score = EXCLUDED.score,
        "circSupply" = EXCLUDED."circSupply",
        mcap = EXCLUDED.mcap,
        "totalSupply" = EXCLUDED."totalSupply",
        price_change_24h = EXCLUDED.price_change_24h,
        updated_at = NOW()
      `,
      [
        row.type,
        row.token_kind,
        row.name,
        row.symbol,
        row.image_url,
        row.contract_address,
        row.pair_address,
        row.decimals,
        row.holders_count,
        row.dex_id,
        row.price_usd,
        row.fdv,
        row.volume_24h,
        row.liquidity_usd,
        row.score,
        row.circSupply,
        row.mcap,
        row.totalSupply,
        row.price_change_24h,
      ]
    );
  }

  const updated = rows.filter(r => existingSet.has(r.contract_address)).length;
  return { inserted: rows.length - updated, updated };
}

async function run(): Promise<void> {
  console.log('Loading secrets...');
  await loadSecrets();

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    synchronize: false,
    entities: [],
    logging: false,
  });

  console.log(`Connecting to ${process.env.DB_HOST}/${process.env.DB_NAME}...`);
  await dataSource.initialize();

  try {
    const memes = mapMemes(loadJson<RhMemeSeed[]>('robinhood-memecoins.json'));
    const rwas = mapRwas(loadJson<RhRwaSeed[]>('robinhood-rwas.json'));
    const nfts = mapNfts(loadJson<RhNftSeed[]>('robinhood-nfts.json'));

    console.log(`Prepared ${memes.length} memecoins, ${rwas.length} RWAs, ${nfts.length} NFTs`);

    await dataSource.transaction(async manager => {
      const memeStats = await upsertRows(manager, memes);
      const rwaStats = await upsertRows(manager, rwas);
      const nftStats = await upsertRows(manager, nfts);

      console.log(
        `Memecoins: ${memeStats.inserted} inserted, ${memeStats.updated} updated`
      );
      console.log(`RWAs: ${rwaStats.inserted} inserted, ${rwaStats.updated} updated`);
      console.log(`NFTs: ${nftStats.inserted} inserted, ${nftStats.updated} updated`);
    });

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM markets WHERE type = $1`,
      [MarketType.robinhood_token]
    );
    console.log(`Done. Robinhood markets in DB: ${count}`);
  } finally {
    await dataSource.destroy();
  }
}

run().catch(error => {
  console.error('Seed failed:', error);
  process.exit(1);
});
