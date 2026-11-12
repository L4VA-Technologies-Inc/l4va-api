/**
 * Static (no network) sanity checks over the process env.
 *
 * Goal: catch config mix-ups before they cause damage — e.g. a mainnet Blockfrost key on a
 * preprod stack, a testnet RPC behind EVM_CHAIN_ID=4663, a treasury address from the wrong
 * network. Every rule is a pure function of the env map so it can be unit-tested.
 */

export type EnvIssueLevel = 'error' | 'warn';

export interface EnvIssue {
  level: EnvIssueLevel;
  key: string;
  message: string;
}

export type EnvMap = Record<string, string | undefined>;

export const RH_MAINNET_CHAIN_ID = 4663;
export const RH_TESTNET_CHAIN_ID = 46630;

const CARDANO_NETWORKS = ['mainnet', 'preprod', 'preview'] as const;
type CardanoNetwork = (typeof CARDANO_NETWORKS)[number];

/** Keys without which the API cannot work at all. */
const REQUIRED_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'REDIS_HOST'];

/** Cardano bech32 addresses that must match CARDANO_NETWORK. */
const CARDANO_ADDRESS_KEYS = ['ADMIN_ADDRESS', 'L4VA_TREASURY_ADDRESS', 'VAULT_SCRIPT_ADDRESS', 'TREASURY_WALLET_CRON'];

/** Hex policy ids / script hashes (28 bytes). */
const CARDANO_HASH_KEYS = [
  'L4VA_POLICY_ID',
  'VLRM_POLICY_ID',
  'SC_POLICY_ID',
  'ADMIN_KEY_HASH',
  'DISPATCH_SCRIPT_HASH',
  'CONTRIBUTION_SCRIPT_HASH',
];

const HEX_64_KEYS = ['REFERENCE_SCRIPT_TX_HASH'];

const EVM_ADDRESS_KEYS = [
  'EVM_FACTORY_ADDRESS',
  'EVM_SWAP_ADAPTER_ADDRESS',
  'EVM_SWAP_ADAPTER_MULTI_PATH',
  'EVM_LP_ADAPTER_ADDRESS',
  'EVM_NFT_SALE_ADAPTER_ADDRESS',
  'EVM_MOCK_ADAPTER_ADDRESS',
  'EVM_BATCH_DEPLOYER_ADDRESS',
  'EVM_ADAPTER_REGISTRY_ADDRESS',
  'EVM_TREASURY_ADDRESS',
  'EVM_ADMIN_ADDRESS',
  'EVM_MINTING_SIGNER_ADDRESS',
  'EVM_GOVERNANCE_FEE_ADDRESS',
  'EVM_WETH_ADDRESS',
  'EVM_UNISWAP_V4_POOL_MANAGER',
  'EVM_UNISWAP_V4_QUOTER',
  'EVM_UNISWAP_V4_STATE_VIEW',
  'EVM_UNISWAP_V3_QUOTER',
  'UNISWAP_FEE_RECIPIENT',
  'BURN_LOCK_ADDRESS',
];

const URL_KEYS = [
  'EVM_RPC_URL',
  'ROBINHOOD_RPC_URL',
  'ROBINHOOD_ALCHEMY_RPC_URL',
  'ANVIL_API_URL',
  'REWARDS_SERVICE_URL',
  'CLIENT_APP_URL',
  'COINGECKO_API_URL',
  'NEXUS_API_URL',
  'DEXHUNTER_BASE_URL',
  'ROBINHOOD_HOLDERS_API_BASE_URL',
  'IPFS_GATEWAY',
];

/** App config keys worth hygiene-checking (skips unrelated OS/shell vars). */
const HYGIENE_KEY_RE =
  /^(EVM_|CARDANO_|BLOCKFROST_|ROBINHOOD_|ALCHEMY_|UNISWAP_|L4VA_|DB_|REDIS_|GCP_|ADMIN_|ANVIL_|NETWORK)|(_KEY|_SECRET|_TOKEN|_URL|_ADDRESS|_ID)$/;

const PLACEHOLDER_RE = /^(changeme|change_me|todo|xxx+|your[_-].*|<.*>|placeholder|example)$/i;

const val = (env: EnvMap, key: string): string | undefined => {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
};

/** Network a URL/host string points at, judged from well-known host fragments. */
function urlNetworkHint(url: string): 'mainnet' | 'testnet' | undefined {
  const u = url.toLowerCase();
  if (/(testnet|preprod|preview|sepolia|goerli|holesky)/.test(u)) return 'testnet';
  if (/(mainnet|prod\.api\.ada-anvil)/.test(u)) return 'mainnet';
  return undefined;
}

export function checkEnv(env: EnvMap): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const err = (key: string, message: string): number => issues.push({ level: 'error', key, message });
  const warn = (key: string, message: string): number => issues.push({ level: 'warn', key, message });

  // --- Required + whitespace / placeholder hygiene -------------------------------------------
  for (const key of REQUIRED_KEYS) {
    if (!val(env, key)) err(key, 'is required but missing/empty');
  }
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || !HYGIENE_KEY_RE.test(key)) continue;
    if (raw !== raw.trim() && raw.trim() !== '') {
      warn(key, 'has leading/trailing whitespace (often a copy-paste error; may break keys/URLs)');
    }
    if (/^["'].*["']$/.test(raw.trim()) && raw.trim().length > 1) {
      warn(key, 'value is wrapped in literal quotes');
    }
    if (PLACEHOLDER_RE.test(raw.trim())) err(key, `looks like a placeholder ("${raw.trim()}")`);
  }

  const jwt = val(env, 'JWT_SECRET');
  if (jwt && jwt.length < 32) warn('JWT_SECRET', `is short (${jwt.length} chars); use ≥32 random chars`);

  // --- Cardano network coherence -------------------------------------------------------------
  const cardanoNetRaw = val(env, 'CARDANO_NETWORK');
  let cardanoNet: CardanoNetwork | undefined;
  if (!cardanoNetRaw) {
    warn('CARDANO_NETWORK', 'is not set; services treat this as NON-mainnet');
  } else if (!(CARDANO_NETWORKS as readonly string[]).includes(cardanoNetRaw)) {
    err('CARDANO_NETWORK', `"${cardanoNetRaw}" is not one of ${CARDANO_NETWORKS.join('/')}`);
  } else {
    cardanoNet = cardanoNetRaw as CardanoNetwork;
  }
  const cardanoMainnet = cardanoNet === 'mainnet';

  const networkId = val(env, 'NETWORK_ID');
  if (cardanoNet && networkId !== undefined) {
    const expected = cardanoMainnet ? '1' : '0';
    if (networkId !== expected) {
      err('NETWORK_ID', `is ${networkId} but CARDANO_NETWORK=${cardanoNet} expects ${expected}`);
    }
  } else if (cardanoMainnet && networkId === undefined) {
    err('NETWORK_ID', 'is missing; builders default to 0 (testnet) while CARDANO_NETWORK=mainnet');
  }

  const network = val(env, 'NETWORK');
  if (cardanoNet && network && network !== cardanoNet) {
    warn('NETWORK', `is "${network}" but CARDANO_NETWORK is "${cardanoNet}"`);
  }

  const bfKey = val(env, 'BLOCKFROST_API_KEY');
  if (!bfKey) {
    err('BLOCKFROST_API_KEY', 'is missing');
  } else if (cardanoNet) {
    if (!bfKey.startsWith(cardanoNet)) {
      const actual = CARDANO_NETWORKS.find(n => bfKey.startsWith(n)) ?? 'unknown';
      err('BLOCKFROST_API_KEY', `is a ${actual} key but CARDANO_NETWORK=${cardanoNet}`);
    }
  }
  const bfMainnet = val(env, 'BLOCKFROST_API_KEY_MAINNET');
  if (bfMainnet && !bfMainnet.startsWith('mainnet')) {
    err('BLOCKFROST_API_KEY_MAINNET', 'is not a mainnet Blockfrost key');
  }

  for (const key of CARDANO_ADDRESS_KEYS) {
    const v = val(env, key);
    if (!v) continue;
    if (!/^(addr|addr_test|stake|stake_test)1[02-9ac-hj-np-z]+$/.test(v)) {
      err(key, 'is not a valid Cardano bech32 address');
      continue;
    }
    const isTest = v.startsWith('addr_test') || v.startsWith('stake_test');
    if (cardanoNet && isTest === cardanoMainnet) {
      err(key, `is a ${isTest ? 'testnet' : 'mainnet'} address but CARDANO_NETWORK=${cardanoNet}`);
    }
  }

  for (const key of CARDANO_HASH_KEYS) {
    const v = val(env, key);
    if (v && !/^[0-9a-f]{56}$/i.test(v)) err(key, `should be 56 hex chars (28-byte hash), got ${v.length} chars`);
  }
  for (const key of HEX_64_KEYS) {
    const v = val(env, key);
    if (v && !/^[0-9a-f]{64}$/i.test(v)) err(key, `should be 64 hex chars (tx hash), got ${v.length} chars`);
  }

  const anvil = val(env, 'ANVIL_API_URL');
  if (anvil && cardanoNet) {
    const hint = urlNetworkHint(anvil);
    if (hint && (hint === 'mainnet') !== cardanoMainnet) {
      err('ANVIL_API_URL', `points at ${hint} but CARDANO_NETWORK=${cardanoNet}`);
    }
  }

  // --- Robinhood / EVM coherence -------------------------------------------------------------
  const chainIdRaw = val(env, 'EVM_CHAIN_ID');
  const chainId = chainIdRaw ? Number(chainIdRaw) : undefined;
  if (!chainIdRaw) {
    warn('EVM_CHAIN_ID', `is not set; code falls back to ${RH_TESTNET_CHAIN_ID} (testnet) in some places`);
  } else if (!Number.isInteger(chainId) || chainId <= 0) {
    err('EVM_CHAIN_ID', `"${chainIdRaw}" is not a positive integer`);
  } else if (chainId !== RH_MAINNET_CHAIN_ID && chainId !== RH_TESTNET_CHAIN_ID) {
    warn('EVM_CHAIN_ID', `${chainId} is neither Robinhood mainnet (4663) nor testnet (46630)`);
  }
  const evmMainnet = chainId === RH_MAINNET_CHAIN_ID;
  const evmKnown = chainId === RH_MAINNET_CHAIN_ID || chainId === RH_TESTNET_CHAIN_ID;

  const uniChain = val(env, 'UNISWAP_CHAIN_ID');
  if (chainIdRaw && uniChain && uniChain !== chainIdRaw) {
    err('UNISWAP_CHAIN_ID', `is ${uniChain} but EVM_CHAIN_ID is ${chainIdRaw}`);
  } else if (!uniChain && evmKnown && !evmMainnet) {
    warn('UNISWAP_CHAIN_ID', 'is not set; Uniswap trading defaults to 4663 (mainnet) while EVM_CHAIN_ID is testnet');
  }

  const alchemyNet = val(env, 'ALCHEMY_NETWORK');
  if (evmKnown) {
    const expected = evmMainnet ? 'robinhood-mainnet' : 'robinhood-testnet';
    if (!alchemyNet && evmMainnet) {
      err('ALCHEMY_NETWORK', `is not set; defaults to robinhood-testnet while EVM_CHAIN_ID=${chainId}`);
    } else if (alchemyNet && alchemyNet !== expected) {
      err('ALCHEMY_NETWORK', `is "${alchemyNet}" but EVM_CHAIN_ID=${chainId} expects "${expected}"`);
    }
  }

  if (evmKnown) {
    for (const key of ['EVM_RPC_URL', 'ROBINHOOD_RPC_URL', 'ROBINHOOD_ALCHEMY_RPC_URL']) {
      const v = val(env, key);
      if (!v) continue;
      const hint = urlNetworkHint(v);
      if (hint && (hint === 'mainnet') !== evmMainnet) {
        err(key, `URL looks like ${hint} but EVM_CHAIN_ID=${chainId}`);
      }
    }
  }
  if (!val(env, 'EVM_RPC_URL')) warn('EVM_RPC_URL', 'is not set; Robinhood features will fail');

  const deployBlock = val(env, 'EVM_FACTORY_DEPLOY_BLOCK');
  if (deployBlock && !/^\d+$/.test(deployBlock)) err('EVM_FACTORY_DEPLOY_BLOCK', 'must be a non-negative integer');

  for (const key of EVM_ADDRESS_KEYS) {
    const v = val(env, key);
    if (!v) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) err(key, 'is not a valid 0x-prefixed 20-byte EVM address');
    else if (/^0x0{40}$/.test(v)) warn(key, 'is the zero address');
  }

  // Duplicate contract addresses usually mean a copy-paste slip between keys.
  const seen = new Map<string, string>();
  for (const key of EVM_ADDRESS_KEYS.filter(
    k =>
      ![
        'EVM_TREASURY_ADDRESS',
        'UNISWAP_FEE_RECIPIENT',
        'EVM_GOVERNANCE_FEE_ADDRESS',
        'EVM_ADMIN_ADDRESS',
        'EVM_MINTING_SIGNER_ADDRESS',
      ].includes(k)
  )) {
    const v = val(env, key)?.toLowerCase();
    if (!v || !/^0x[0-9a-f]{40}$/.test(v)) continue;
    const other = seen.get(v);
    if (other) warn(key, `has the same address as ${other}`);
    else seen.set(v, key);
  }

  // --- Cross-chain / environment coherence ---------------------------------------------------
  if (cardanoNet && evmKnown && cardanoMainnet !== evmMainnet) {
    warn(
      'CARDANO_NETWORK/EVM_CHAIN_ID',
      `mixed networks: Cardano=${cardanoNet}, Robinhood=${evmMainnet ? 'mainnet' : 'testnet'} — intended?`
    );
  }

  const nodeEnv = val(env, 'NODE_ENV');
  if (nodeEnv === 'production' && cardanoNet && !cardanoMainnet) {
    warn('NODE_ENV', `is production but CARDANO_NETWORK=${cardanoNet}`);
  }
  if ((cardanoMainnet || evmMainnet) && (nodeEnv === 'development' || nodeEnv === 'dev')) {
    warn('NODE_ENV', 'is development on a mainnet config — Slack alerts are suppressed in dev');
  }
  if ((cardanoMainnet || evmMainnet) && !val(env, 'SLACK_BOT_TOKEN')) {
    warn('SLACK_BOT_TOKEN', 'is not set on a mainnet config; no alerts will be delivered');
  }

  // --- Generic format checks -----------------------------------------------------------------
  for (const key of URL_KEYS) {
    const v = val(env, key);
    if (!v) continue;
    try {
      const u = new URL(v);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) err(key, `unexpected protocol ${u.protocol}`);
      else if (
        u.protocol === 'http:' &&
        (cardanoMainnet || evmMainnet) &&
        !/^(localhost|127\.|10\.|192\.168\.|host\.docker)/.test(u.hostname)
      ) {
        warn(key, 'uses plain http on a mainnet config');
      }
    } catch {
      err(key, 'is not a valid URL');
    }
  }

  for (const key of ['DB_PORT', 'REDIS_PORT', 'BULL_REDIS_PORT', 'PORT']) {
    const v = val(env, key);
    if (v && !(/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536)) err(key, `"${v}" is not a valid port`);
  }

  return issues;
}

/** Hides everything but a short prefix so secrets never land in logs/Slack. */
export function redact(value: string | undefined): string {
  if (!value) return '<empty>';
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}…(${value.length})`;
}
