import { isAddress, type Address, type Hex } from 'viem';

import { type RouteConfig, encodeRoute } from './fee-keeper.routes';

/**
 * Env-driven configuration for the protocol fee keeper.
 *
 *   FEE_KEEPER_ENABLED            true|1 to run (default: disabled)
 *   FEE_KEEPER_PRIVATE_KEY        dedicated key: KEEPER_ROLE on FeeConverter (+ EXECUTOR_ROLE on BuybackExecutor)
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
 *   BUYBACK_KEEPER_ENABLED        true|1 to also run BuybackExecutor.executeAll
 *   BUYBACK_EXECUTOR_ADDRESS
 *   BUYBACK_ROUTE_JSON            RouteConfig for feeToken → L4VA
 *   BUYBACK_MIN_RESERVE           skip while FeeController.totalReserve() is below this (raw feeToken)
 *   BUYBACK_SLIPPAGE_BPS          default 100, max 1000; minOut is never below the on-chain price floor
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
  buyback: {
    enabled: boolean;
    executor?: Address;
    route?: RouteConfig;
    encodedRoute?: Hex;
    minReserve: bigint;
    slippageBps: number;
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
  const buybackEnabled = flag(env.BUYBACK_KEEPER_ENABLED);

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
      buyback: { enabled: false, minReserve: 0n, slippageBps: 100 },
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

  let buyback: FeeKeeperConfig['buyback'] = {
    enabled: false,
    minReserve: bigintOr(env, 'BUYBACK_MIN_RESERVE', 0n),
    slippageBps: intInRange(env, 'BUYBACK_SLIPPAGE_BPS', 100, 0, MAX_KEEPER_SLIPPAGE_BPS),
  };
  if (buybackEnabled) {
    const route = parseJson<RouteConfig>(env, 'BUYBACK_ROUTE_JSON');
    let encodedRoute: Hex;
    try {
      encodedRoute = encodeRoute(route);
    } catch (err) {
      throw new Error(`BUYBACK_ROUTE_JSON invalid: ${(err as Error).message}`);
    }
    buyback = { ...buyback, enabled: true, executor: requireAddress(env, 'BUYBACK_EXECUTOR_ADDRESS'), route, encodedRoute };
  }

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
    buyback,
  };
}
