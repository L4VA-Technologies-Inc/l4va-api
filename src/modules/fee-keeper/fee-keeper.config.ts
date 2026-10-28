import { isAddress, type Address, type Hex } from 'viem';

import { type RouteConfig, encodeRoute } from './fee-keeper.routes';

/**
 * Env-driven configuration for the protocol fee keeper.
 *
 *   FEE_KEEPER_ENABLED            true|1 to run (default: disabled)
 *   FEE_KEEPER_PRIVATE_KEY        dedicated key: KEEPER_ROLE on FeeConverter (+ EXECUTOR_ROLE on FeeController)
 *   EVM_RPC_URL                   RPC (shared with the rest of the EVM stack)
 *   FEE_CONVERTER_ADDRESS         FeeConverter (must be ProtocolFeeConfig.feeRecipient)
 *   FEE_CONTROLLER_ADDRESS        FeeController
 *   FEE_SWAP_ADAPTER_ADDRESS      UniversalRouterSwapAdapter (swap-tagged in AdapterRegistry)
 *   FEE_KEEPER_WETH_ADDRESS       WETH on this chain (v3 routes use it for native legs)
 *   FEE_KEEPER_ROUTES_JSON        [{"asset":"0x…","route":{…RouteConfig}}]  asset → feeToken
 *   FEE_KEEPER_SLIPPAGE_BPS       default 100 (1%), max 1000
 *   FEE_KEEPER_MIN_CONVERT_OUT    skip conversions whose simulated feeToken output is below this (raw units)
 *   FEE_KEEPER_MAX_RETRIES        default 3 (pre-broadcast transient errors only)
 *   FEE_KEEPER_TX_TIMEOUT_MS      default 120000
 *   FEE_KEEPER_MIN_GAS_WEI        alert when the keeper's native balance drops below this
 *   FEE_KEEPER_VAULT_BATCH        vaults per `collect` call, default 20
 *
 *   FEE_KEEPER_MIN_INTERVAL_MINUTES  random gap between buys, lower bound (default 60)
 *   FEE_KEEPER_MAX_INTERVAL_MINUTES  random gap between buys, upper bound (default 240)
 *   FEE_KEEPER_MIN_CHUNK_BPS         each buy spends a random 30–100% (default 3000) of
 *                                    min(balance, maxConversionAmount)
 *
 *   FEE_KEEPER_DISTRIBUTE_ENABLED    true|1 to pay out FeeController's L4VA buckets
 *                                    (keeper needs EXECUTOR_ROLE on FeeController)
 *   FEE_KEEPER_TREASURY_ADDRESS      receives the 25% treasury bucket
 *   FEE_KEEPER_OPS_ADDRESS           receives the 50% operations bucket
 *                                    (the 25% burn bucket is burned by the keeper)
 *
 * The fee token is L4VA: `convert` buys L4VA directly (ETH fees through the ETH/L4VA
 * v4 pool) and FeeController splits it 25 / 25 / 50. There is no intermediate token
 * and no BuybackExecutor.
 */
export interface FeeKeeperRouteEntry {
  asset: Address;
  route: RouteConfig;
  encoded: Hex;
}

export interface FeeKeeperConfig {
  enabled: boolean;
  rpcUrl: string;
  privateKey: Hex;
  feeConverter: Address;
  feeController: Address;
  swapAdapter: Address;
  weth: Address;
  routes: FeeKeeperRouteEntry[];
  slippageBps: number;
  minConvertOut: bigint;
  maxRetries: number;
  txTimeoutMs: number;
  minGasWei: bigint;
  vaultBatchSize: number;
  buy: {
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    minChunkBps: number;
  };
  distribute: {
    enabled: boolean;
    treasury?: Address;
    operations?: Address;
  };
}

type Env = Record<string, string | undefined>;

const MAX_KEEPER_SLIPPAGE_BPS = 1_000;

function flag(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

function requireAddress(env: Env, key: string): Address {
  const v = env[key];
  if (!v || !isAddress(v)) throw new Error(`${key} must be a valid address`);
  return v as Address;
}

function intInRange(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  const n = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return n;
}

function bigintOr(env: Env, key: string, def: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer (raw units)`);
  return BigInt(raw);
}

function parseJson<T>(env: Env, key: string): T {
  const raw = env[key];
  if (!raw) throw new Error(`${key} is required`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${key} is not valid JSON`);
  }
}

/** Returns `{ enabled: false }`-shaped config when disabled; throws on invalid config when enabled. */
export function loadFeeKeeperConfig(env: Env): FeeKeeperConfig {
  const enabled = flag(env.FEE_KEEPER_ENABLED);

  if (!enabled) {
    return {
      enabled: false,
      rpcUrl: '',
      privateKey: '0x',
      feeConverter: '0x0000000000000000000000000000000000000000',
      feeController: '0x0000000000000000000000000000000000000000',
      swapAdapter: '0x0000000000000000000000000000000000000000',
      weth: '0x0000000000000000000000000000000000000000',
      routes: [],
      slippageBps: 100,
      minConvertOut: 0n,
      maxRetries: 3,
      txTimeoutMs: 120_000,
      minGasWei: 0n,
      vaultBatchSize: 20,
      buy: { minIntervalMinutes: 60, maxIntervalMinutes: 240, minChunkBps: 3000 },
      distribute: { enabled: false },
    };
  }

  const rpcUrl = env.EVM_RPC_URL;
  if (!rpcUrl) throw new Error('EVM_RPC_URL is required');
  const privateKey = env.FEE_KEEPER_PRIVATE_KEY;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('FEE_KEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  }

  const rawRoutes = parseJson<Array<{ asset: string; route: RouteConfig }>>(env, 'FEE_KEEPER_ROUTES_JSON');
  if (!Array.isArray(rawRoutes)) throw new Error('FEE_KEEPER_ROUTES_JSON must be an array');
  const seen = new Set<string>();
  const routes: FeeKeeperRouteEntry[] = rawRoutes.map((r, i) => {
    if (!r || typeof r.asset !== 'string' || !isAddress(r.asset)) {
      throw new Error(`FEE_KEEPER_ROUTES_JSON[${i}].asset must be an address (0x0…0 for native)`);
    }
    const key = r.asset.toLowerCase();
    if (seen.has(key)) throw new Error(`FEE_KEEPER_ROUTES_JSON has a duplicate asset ${r.asset}`);
    seen.add(key);
    try {
      return { asset: r.asset as Address, route: r.route, encoded: encodeRoute(r.route) };
    } catch (err) {
      throw new Error(`FEE_KEEPER_ROUTES_JSON[${i}].route invalid: ${(err as Error).message}`);
    }
  });

  const buy: FeeKeeperConfig['buy'] = {
    minIntervalMinutes: intInRange(env, 'FEE_KEEPER_MIN_INTERVAL_MINUTES', 60, 10, 7 * 24 * 60),
    maxIntervalMinutes: intInRange(env, 'FEE_KEEPER_MAX_INTERVAL_MINUTES', 240, 10, 7 * 24 * 60),
    minChunkBps: intInRange(env, 'FEE_KEEPER_MIN_CHUNK_BPS', 3000, 1, 10_000),
  };
  if (buy.minIntervalMinutes > buy.maxIntervalMinutes) {
    throw new Error('FEE_KEEPER_MIN_INTERVAL_MINUTES must not exceed FEE_KEEPER_MAX_INTERVAL_MINUTES');
  }

  const distribute: FeeKeeperConfig['distribute'] = flag(env.FEE_KEEPER_DISTRIBUTE_ENABLED)
    ? {
        enabled: true,
        treasury: requireAddress(env, 'FEE_KEEPER_TREASURY_ADDRESS'),
        operations: requireAddress(env, 'FEE_KEEPER_OPS_ADDRESS'),
      }
    : { enabled: false };

  return {
    enabled: true,
    rpcUrl,
    privateKey: privateKey as Hex,
    feeConverter: requireAddress(env, 'FEE_CONVERTER_ADDRESS'),
    feeController: requireAddress(env, 'FEE_CONTROLLER_ADDRESS'),
    swapAdapter: requireAddress(env, 'FEE_SWAP_ADAPTER_ADDRESS'),
    weth: requireAddress(env, 'FEE_KEEPER_WETH_ADDRESS'),
    routes,
    slippageBps: intInRange(env, 'FEE_KEEPER_SLIPPAGE_BPS', 100, 0, MAX_KEEPER_SLIPPAGE_BPS),
    minConvertOut: bigintOr(env, 'FEE_KEEPER_MIN_CONVERT_OUT', 0n),
    maxRetries: intInRange(env, 'FEE_KEEPER_MAX_RETRIES', 3, 0, 10),
    txTimeoutMs: intInRange(env, 'FEE_KEEPER_TX_TIMEOUT_MS', 120_000, 10_000, 900_000),
    minGasWei: bigintOr(env, 'FEE_KEEPER_MIN_GAS_WEI', 0n),
    vaultBatchSize: intInRange(env, 'FEE_KEEPER_VAULT_BATCH', 20, 1, 100),
    buy,
    distribute,
  };
}
