import { ConfigService } from '@nestjs/config';
import type { Address, Chain, Hex } from 'viem';
import { defineChain } from 'viem';

import { ChainType } from '@/types/vault.types';

/**
 * Everything that differs between the EVM chains we deploy on. One entry per chain;
 * services resolve it from a vault's `chain_type` / `chain_id` instead of reading
 * `EVM_*` env vars, which only ever described Robinhood.
 */
export interface EvmChainConfig {
  chainType: ChainType;
  chainId: number;
  name: string;
  rpcUrl: string;
  /** Extra RPCs tried when the primary one fails (transient DNS/provider outages). */
  fallbackRpcUrls: string[];
  /** Native gas token: ETH on Robinhood, USDC on Arc (still 18 decimals). */
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** How to price the native token in USD: ETH spot, or 1:1 for a USD stablecoin. */
  nativeUsdPrice: 'eth' | 'usd-stable';
  factoryAddress?: Address;
  /** BatchVaultDeployer — the archetype every vault is created from. */
  batchDeployerAddress?: Address;
  adapterRegistryAddress?: Address;
  adminAddress?: Address;
  adminPrivateKey?: Hex;
  mintingSignerAddress?: Address;
  mintingSignerPrivateKey?: Hex;
  treasuryAddress?: Address;
  /**
   * Arc rejects any transaction whose gas limit exceeds 2^24, well below its 30M block
   * limit (`gas limit too high`, found on the 2026-09-17 testnet run). Undefined = no cap.
   */
  maxTxGas?: bigint;
  /** Arc's mempool silently drops transactions below 20 gwei maxFeePerGas. */
  minMaxFeePerGasWei?: bigint;
  /** Arc finalizes on inclusion, so one confirmation is enough. */
  confirmations: number;
  /** Signing key of this chain's Alchemy custom webhook, when one exists. */
  alchemyWebhookSigningKey?: string;
  /** DexScreener chain slug, when it indexes the chain. */
  dexScreenerSlug?: string;
  /** Which swap adapter the governance flow may use. */
  swap: 'uniswap' | 'testnet-adapter' | 'none';
  /**
   * Blockscout-style `/api/v2` base for token holders. Snapshot must hit the
   * vault's own explorer — never another chain's as a fallback.
   */
  holdersApiBaseUrl?: string;
}

const GWEI = 1_000_000_000n;

/** Defaults that are properties of the chain itself, not of our deployment. */
const CHAIN_DEFAULTS: Record<string, Partial<EvmChainConfig> & Pick<EvmChainConfig, 'name' | 'nativeCurrency'>> = {
  [ChainType.robinhood]: {
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    nativeUsdPrice: 'eth',
    confirmations: 1,
    dexScreenerSlug: 'robinhood',
    swap: 'uniswap',
  },
  [ChainType.arc]: {
    name: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    nativeUsdPrice: 'usd-stable',
    maxTxGas: 16_777_216n,
    minMaxFeePerGasWei: 20n * GWEI,
    confirmations: 1,
    dexScreenerSlug: 'arc',
    swap: 'testnet-adapter',
  },
};

/** Public endpoints used as backups when the configured provider is unreachable. */
const PUBLIC_FALLBACK_RPCS: Record<string, { testnet: string[]; mainnet: string[] }> = {
  [ChainType.arc]: {
    testnet: ['https://rpc.testnet.arc.io', 'https://rpc.drpc.testnet.arc.io'],
    mainnet: ['https://rpc.mainnet.arc.io'],
  },
  [ChainType.robinhood]: {
    testnet: ['https://rpc.testnet.chain.robinhood.com'],
    mainnet: ['https://rpc.mainnet.chain.robinhood.com'],
  },
};

const DEFAULT_CHAIN_IDS: Record<string, number> = {
  [ChainType.robinhood]: 46630,
  [ChainType.arc]: 5042002,
};

const DEFAULT_HOLDERS_API: Record<string, { testnet: string; mainnet: string }> = {
  [ChainType.robinhood]: {
    testnet: 'https://explorer.testnet.chain.robinhood.com/api/v2',
    mainnet: 'https://robinhoodchain.blockscout.com/api/v2',
  },
  [ChainType.arc]: {
    testnet: 'https://explorer.testnet.arc.io/api/v2',
    mainnet: 'https://explorer.arc.io/api/v2',
  },
};

const isTestnetDeployment = (chainType: ChainType, chainId: number, rpcUrl: string): boolean => {
  const rpc = rpcUrl.toLowerCase();
  if (rpc.includes('testnet') || rpc.includes('preprod') || rpc.includes('sepolia')) return true;
  if (chainType === ChainType.arc && chainId === DEFAULT_CHAIN_IDS[ChainType.arc]) return true;
  if (chainType === ChainType.robinhood && chainId === DEFAULT_CHAIN_IDS[ChainType.robinhood]) return true;
  return false;
};

const defaultHoldersApiBaseUrl = (chainType: ChainType, chainId: number, rpcUrl: string): string | undefined => {
  const pair = DEFAULT_HOLDERS_API[chainType];
  if (!pair) return undefined;
  return isTestnetDeployment(chainType, chainId, rpcUrl) ? pair.testnet : pair.mainnet;
};

/**
 * Robinhood keeps reading the legacy unprefixed `EVM_*` variables so existing
 * deployments need no env changes; every other chain uses a `<PREFIX>_` form,
 * e.g. `ARC_RPC_URL`, `ARC_FACTORY_ADDRESS`.
 */
const readVar = (config: ConfigService, chainType: ChainType, suffix: string): string | undefined => {
  const prefixed = config.get<string>(`${chainType.toUpperCase()}_${suffix}`)?.trim();
  if (prefixed) return prefixed;
  if (chainType === ChainType.robinhood) return config.get<string>(`EVM_${suffix}`)?.trim() || undefined;
  return undefined;
};

const buildChain = (config: ConfigService, chainType: ChainType): EvmChainConfig | null => {
  // `<CHAIN>_RPC_URL` may hold several comma-separated endpoints, primary first.
  const rpcUrls = (readVar(config, chainType, 'RPC_URL') ?? '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
  const rpcUrl = rpcUrls[0];
  if (!rpcUrl) return null;

  const defaults = CHAIN_DEFAULTS[chainType];
  const chainId = Number(readVar(config, chainType, 'CHAIN_ID') ?? DEFAULT_CHAIN_IDS[chainType]);
  const asAddress = (suffix: string) => readVar(config, chainType, suffix) as Address | undefined;
  const holdersApiBaseUrl =
    readVar(config, chainType, 'HOLDERS_API_BASE_URL') ||
    (chainType === ChainType.robinhood ? config.get<string>('ROBINHOOD_HOLDERS_API_BASE_URL')?.trim() : undefined) ||
    defaultHoldersApiBaseUrl(chainType, chainId, rpcUrl);

  const publicFallbacks = PUBLIC_FALLBACK_RPCS[chainType];
  const fallbackRpcUrls = [
    ...rpcUrls.slice(1),
    ...(readVar(config, chainType, 'RPC_URL_FALLBACK') ?? '')
      .split(',')
      .map(url => url.trim())
      .filter(Boolean),
    ...(publicFallbacks
      ? isTestnetDeployment(chainType, chainId, rpcUrl)
        ? publicFallbacks.testnet
        : publicFallbacks.mainnet
      : []),
  ].filter(url => url !== rpcUrl);

  return {
    chainType,
    chainId,
    rpcUrl,
    fallbackRpcUrls: [...new Set(fallbackRpcUrls)],
    holdersApiBaseUrl,
    factoryAddress: asAddress('FACTORY_ADDRESS'),
    batchDeployerAddress: asAddress('BATCH_DEPLOYER_ADDRESS'),
    adapterRegistryAddress: asAddress('ADAPTER_REGISTRY_ADDRESS'),
    adminAddress: asAddress('ADMIN_ADDRESS'),
    adminPrivateKey: readVar(config, chainType, 'ADMIN_PRIVATE_KEY') as Hex | undefined,
    mintingSignerAddress: asAddress('MINTING_SIGNER_ADDRESS'),
    mintingSignerPrivateKey: readVar(config, chainType, 'MINTING_SIGNER_PRIVATE_KEY') as Hex | undefined,
    treasuryAddress: asAddress('TREASURY_ADDRESS'),
    alchemyWebhookSigningKey: readVar(config, chainType, 'ALCHEMY_WEBHOOK_SIGNING_KEY'),
    ...defaults,
  } as EvmChainConfig;
};

/** Chains with an RPC configured, in `EVM_CHAINS` order (default: robinhood, arc). */
export const loadEvmChains = (config: ConfigService): EvmChainConfig[] => {
  const requested = (config.get<string>('EVM_CHAINS') ?? `${ChainType.robinhood},${ChainType.arc}`)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean) as ChainType[];

  return requested.map(chainType => buildChain(config, chainType)).filter((chain): chain is EvmChainConfig => !!chain);
};

/** viem chain object for RPC clients. */
export const toViemChain = (chain: EvmChainConfig): Chain =>
  defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  });
