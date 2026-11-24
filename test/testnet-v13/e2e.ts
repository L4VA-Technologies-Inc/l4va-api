/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- dev driver run with ts-node --transpile-only; viem generics over dynamic ABIs do not type-check
/**
 * V13 end-to-end driver for Robinhood testnet (46630) against a LOCAL API.
 *
 * Plays users through the same HTTP calls the client makes (SIWE login, vault creation +
 * factory tx + publish, contribute / acquire with backend-signed authorizations + confirm) and
 * reads the result back from the chain. The lifecycle crons of the local API do the rest
 * (close, snapshot, claims, LP), so this exercises the backend's V13 paths for real.
 *
 *   ENV_FILE=.env.local npx nest start        # local API on testnet (separate terminal)
 *   npx ts-node -r tsconfig-paths/register --transpile-only test/testnet-v13/e2e.ts <command>
 *
 * Commands:
 *   create <name> <acqlp|mixed|fromsale> [owner]   create + publish a vault (owner default alice)
 *   contribute <name> <wallet> <tUSDC>             asset contribution (mints test tUSDC first)
 *   acquire <name> <wallet> <eth>                  native acquire
 *   status <name>                                  API + on-chain view of the vault
 *   approve-root <name> | cancel-root <name>       as the verifier (dave)
 *
 * Wallet keys come from ../vault-contract-solidity/.env (testnet only). State: E2E_STATE or
 * test/testnet-v13/.state.json (gitignored by the .state pattern below — never commit it).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { VAULT_V13_ABI } from '@/modules/vaults/processing-tx/onchain/evm-v13';
import { VAULT_CONFIG_ABI_V13 } from '@/modules/vaults/processing-tx/onchain/evm-vault-signer.service';

const API = process.env.E2E_API ?? 'http://localhost:3000/api/v1';
const ORIGIN = 'https://testnet.l4va.org';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const TUSDC = '0x3C64b06b274763461443e795305319E636bdF967' as Address;
const STATE = process.env.E2E_STATE ?? `${__dirname}/.state.json`;
const chain = {
  id: 46630,
  name: 'rh-testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

const env = Object.fromEntries(
  readFileSync(`${__dirname}/../../../vault-contract-solidity/.env`, 'utf8')
    .split('\n')
    .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map(m => [m[1], m[2].trim()])
);
const KEYS: Record<string, Hex> = {
  alice: env.ALICE_PRIVATE_KEY as Hex,
  bob: env.BOB_PRIVATE_KEY as Hex,
  carol: env.CAROL_PRIVATE_KEY as Hex,
  dave: env.DAVE_PRIVATE_KEY as Hex,
};

/** Verifier / guardian calls the backend never makes. */
const VERIFIER_ABI = parseAbi([
  'function approveAllocationRoot(uint256 cycleId)',
  'function cancelAllocationRoot(uint256 cycleId)',
  'function approveDistribution(uint256 distributionId)',
  'function cancelDistribution(uint256 distributionId)',
]);

const pub = createPublicClient({ chain, transport: http(RPC) });
const walletOf = (name: string) => {
  const account = privateKeyToAccount(KEYS[name]);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC) }) };
};

type State = Record<string, { dbId: string; address?: Address; scenario: string; owner: string }>;
const loadState = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const saveState = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));

// --------------------------------------------------------------------------- HTTP

const tokens = new Map<string, string>();

async function api<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return data as T;
}

async function login(name: string): Promise<string> {
  const cached = tokens.get(name);
  if (cached) return cached;
  const { account } = walletOf(name);
  const { message } = await api<{ message: string }>('POST', '/auth/evm/challenge', { walletAddress: account.address });
  const evmSignature = await account.signMessage({ message });
  const res = await api<{ accessToken: string }>('POST', '/auth/login', {
    chainType: 'robinhood',
    walletAddress: account.address,
    evmSignature,
  });
  tokens.set(name, res.accessToken);
  return res.accessToken;
}

const unwrap = (r: any) => r?.data ?? r;

async function waitTx(hash: Hex): Promise<void> {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error(`tx ${hash} reverted`);
}

// --------------------------------------------------------------------------- vault creation

const FIVE_MIN = 5 * 60 * 1000;

function vaultPayload(name: string, scenario: string) {
  const base = {
    name: `V13 e2e ${name}`,
    type: 'cnt',
    privacy: 'public',
    vaultTokenTicker: `V13${name
      .replace(/[^a-z0-9]/gi, '')
      .slice(-6)
      .toUpperCase()}`,
    description: 'V13 testnet end-to-end run',
    tokenDescription: 'test',
    isExpandableAssetWhitelist: false,
    vaultImage: 'https://testnet.l4va.org/favicon.ico',
    ftTokenImg: 'https://testnet.l4va.org/favicon.ico',
    socialLinks: [],
    tags: [],
    contributorWhitelist: [],
    valueMethod: 'lbe',
    contributionOpenWindowType: 'upon-vault-launch',
    contributionOpenWindowTime: null,
    contributionDuration: FIVE_MIN,
    assetsWhitelist: [
      {
        policyId: TUSDC,
        assetName: '',
        name: 'tUSDC',
        countCapMin: 1,
        countCapMax: 1_000_000_000_000,
        valuationMethod: 'market',
      },
    ],
    acquireWindowDuration: FIVE_MIN,
    acquireOpenWindowType: 'upon-asset-window-closing',
    acquireOpenWindowTime: null,
    acquirerWhitelist: [],
    acquireReserve: 0,
    isAcquireOnly: false,
    vaultArchetype: 'standard',
    minAcquireThreshold: null,
    allowAcquireExpansion: true,
    ftTokenSupply: 1_000_000,
    terminationType: 'dao',
    creationThreshold: 0.1,
    voteThreshold: 0,
    executionThreshold: 51,
    cosigningThreshold: 33,
    chainType: 'robinhood',
  };
  switch (scenario) {
    case 'acqlp': // acquire-only, LP from the raise (FromAcquire)
      return {
        ...base,
        isAcquireOnly: true,
        tokensForAcquires: 100,
        liquidityPoolContribution: 10,
        assetsWhitelist: [{ ...base.assetsWhitelist[0], countCapMin: 0 }],
      };
    case 'mixed': // contributions then acquire, LP from the raise (FromAcquire)
      return { ...base, tokensForAcquires: 50, liquidityPoolContribution: 10 };
    case 'fromsale': // tokens only, LP from selling a slice of them (FromSale)
      return {
        ...base,
        tokensForAcquires: 0,
        liquidityPoolContribution: 10,
        acquireWindowDuration: null,
        acquireOpenWindowType: null,
      };
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

function toBigInts(v: any): any {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(toBigInts);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toBigInts(x)]));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  return v;
}

const FACTORY_V13_ABI = [
  {
    type: 'function',
    name: 'createVault',
    stateMutability: 'nonpayable',
    inputs: [VAULT_CONFIG_ABI_V13[0], { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    outputs: [{ type: 'address' }, { type: 'address' }],
  },
] as const;

async function create(name: string, scenario: string, owner = 'alice'): Promise<void> {
  const state = loadState();
  if (state[name]) throw new Error(`${name} already exists in state`);
  const token = await login(owner);
  const res = unwrap(await api('POST', '/vaults', vaultPayload(name, scenario), token));
  if (res.evmConfigVersion !== 13)
    throw new Error(`expected a V13 config, got ${JSON.stringify(res.evmConfigVersion)}`);
  const cfg = toBigInts(res.evmVaultConfig);
  console.log(`economics: ${JSON.stringify(res.evmVaultConfig.economics)}`);

  const { client } = walletOf(owner);
  const hash = await client.writeContract({
    address: res.evmFactoryAddress,
    abi: FACTORY_V13_ABI as any,
    functionName: 'createVault',
    args: [cfg, BigInt(res.adminNonce), BigInt(res.deadline), res.adminSignature],
  });
  await waitTx(hash);
  await api(
    'POST',
    '/vaults/publish',
    { vaultId: res.vaultId, txId: res.transactionId, txHash: hash, chainType: 'robinhood' },
    token
  );
  state[name] = { dbId: res.vaultId, scenario, owner };
  saveState(state);
  console.log(`created ${name}: db=${res.vaultId} tx=${hash}`);
}

async function vaultAddress(name: string): Promise<Address> {
  const state = loadState();
  const v = state[name];
  if (!v) throw new Error(`unknown vault ${name}`);
  if (v.address) return v.address;
  const detail = unwrap(await api('GET', `/vaults/${v.dbId}`, undefined, await login(v.owner)));
  const addr = (detail.contractAddress ?? detail.contract_address) as Address | undefined;
  if (!addr) throw new Error(`vault ${name} has no contract address yet (status ${detail.vaultStatus})`);
  v.address = addr;
  saveState(state);
  return addr;
}

// --------------------------------------------------------------------------- contributions

async function contributeOrAcquire(name: string, who: string, kind: 'contribute' | 'acquire', amount: string) {
  const v = loadState()[name];
  const token = await login(who);
  const { client, account } = walletOf(who);
  let assets;
  if (kind === 'contribute') {
    const raw = BigInt(Math.round(Number(amount) * 1e6));
    const bal = (await pub.readContract({
      address: TUSDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })) as bigint;
    if (bal < raw) {
      const h = await client.writeContract({
        address: TUSDC,
        abi: [
          {
            type: 'function',
            name: 'mint',
            stateMutability: 'nonpayable',
            inputs: [{ type: 'address' }, { type: 'uint256' }],
            outputs: [],
          },
        ],
        functionName: 'mint',
        args: [account.address, raw - bal],
      });
      await waitTx(h);
    }
    assets = [
      {
        policyId: TUSDC,
        type: 'ft',
        assetName: '',
        quantity: raw.toString(),
        displayName: 'tUSDC',
        decimals: 6,
        metadata: { decimals: 6, standard: 'ERC20' },
      },
    ];
  } else {
    assets = [
      {
        assetName: 'eth',
        policyId: '0x0000000000000000000000000000000000000000',
        type: 'eth',
        quantity: parseEther(amount).toString(),
        metadata: { rawWei: true },
      },
    ];
  }
  const created = unwrap(await api('POST', `/${kind}/${v.dbId}`, { assets }, token));
  const txId = created.txId;
  let prepared = unwrap(await api('POST', '/blockchain/evm/contribution/prepare', { txId }, token));
  if (prepared.feePayment) {
    const fee = prepared.feePayment;
    const h = await client.sendTransaction({ to: fee.to, value: BigInt(fee.value ?? fee.amountWei ?? fee.amount) });
    await waitTx(h);
    prepared = unwrap(await api('POST', '/blockchain/evm/contribution/prepare', { txId, feeTxHash: h }, token));
  }
  if (process.env.E2E_DEBUG) console.log(JSON.stringify(prepared, null, 2));
  const childTxHashes: Hex[] = [];
  let primary: Hex | null = null;
  for (const call of prepared.calls) {
    if (call.approval?.required) {
      const h = await client.writeContract({
        address: call.approval.token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [prepared.vaultAddress, BigInt(call.approval.amountOrTokenId)],
      });
      await waitTx(h);
      childTxHashes.push(h);
    }
    const auth = toBigInts(call.authorization);
    auth.kind = Number(auth.kind);
    const h = await client.writeContract({
      address: prepared.vaultAddress,
      abi: VAULT_V13_ABI,
      functionName: call.functionName,
      args: [auth, call.signature],
      value: Number(auth.kind) === 0 ? BigInt(call.value ?? auth.amount) : 0n,
    });
    await waitTx(h);
    childTxHashes.push(h);
    primary = h;
  }
  await api('POST', '/blockchain/evm/contribution/confirm', { txId, txHash: primary, childTxHashes }, token);
  console.log(`${who} ${kind} ${amount} → ${name} tx=${primary}`);
}

// --------------------------------------------------------------------------- status / verifier

async function status(name: string) {
  const v = loadState()[name];
  const detail = unwrap(await api('GET', `/vaults/${v.dbId}`, undefined, await login(v.owner)));
  console.log(`API: status=${detail.vaultStatus} evmV13=${JSON.stringify(detail.evmV13)}`);
  const address = await vaultAddress(name);
  const read = (functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: VAULT_V13_ABI, functionName, args } as any) as Promise<any>;
  const [st, cid, econ, budget, rate, seeded] = await Promise.all([
    read('status'),
    read('currentCycleId'),
    read('economics'),
    read('lpNativeBudget'),
    read('lpVtPerNative'),
    read('lpSeeded'),
  ]);
  console.log(
    `chain: vault=${address} status=${st} cycle=${cid} lpBudget=${formatEther(budget)} lpRate=${rate} lpSeeded=${seeded}`
  );
  console.log(`economics: ${JSON.stringify(econ, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`);
  for (let c = 1n; c <= cid; c++) {
    const r = await read('cycleV13', [c]);
    console.log(
      `cycle ${c}: vtCap=${r[0]} acquirerPool=${r[2]} rootVtMax=${r[3]} rootNativeMax=${r[4]} activatesAt=${r[5]} cancelled=${r[6]} approved=${r[7]}`
    );
  }
  const vt = (await read('vaultToken')) as Address;
  for (const who of Object.keys(KEYS)) {
    const a = privateKeyToAccount(KEYS[who]).address;
    const bal = (await pub.readContract({
      address: vt,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [a],
    })) as bigint;
    const ent = await read('onchainEntitlement', [1n, a]);
    if (bal > 0n || ent[0] > 0n)
      console.log(`  ${who}: VT ${formatEther(bal)}  on-chain entitlement c1 ${formatEther(ent[0])} claimed=${ent[1]}`);
  }
  try {
    const tokens = (await read('lpSliceTokens')) as Address[];
    for (const t of tokens) {
      const [slice, sold] = await read('lpSlice', [t]);
      console.log(`  LP slice ${t}: ${sold}/${slice} sold`);
    }
  } catch {
    /* no slices */
  }
}

async function verifier(name: string, fn: 'approveAllocationRoot' | 'cancelAllocationRoot', cycle = '1') {
  const address = await vaultAddress(name);
  const { client } = walletOf('dave');
  const h = await client.writeContract({ address, abi: VERIFIER_ABI, functionName: fn, args: [BigInt(cycle)] });
  await waitTx(h);
  console.log(`${fn}(${cycle}) on ${name} tx=${h}`);
}

async function waitStatus(name: string, target: string, timeoutMin = '25') {
  const v = loadState()[name];
  const deadline = Date.now() + Number(timeoutMin) * 60_000;
  for (;;) {
    const detail = unwrap(await api('GET', `/vaults/${v.dbId}`, undefined, await login(v.owner)));
    if (detail.vaultStatus === target) {
      console.log(`${name} is ${target}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${name} still ${detail.vaultStatus} (waited for ${target})`);
    await new Promise(r => setTimeout(r, 15_000));
  }
}

// --------------------------------------------------------------------------- governance

/** `amount` is ETH, or raw units of `asset` when one is given. */
async function proposeDistribution(name: string, who: string, amount: string, asset?: string, durationMs = '300000') {
  const native = !asset || /^0x0{40}$/i.test(asset);
  const v = loadState()[name];
  const token = await login(who);
  const res = unwrap(
    await api(
      'POST',
      `/governance/vaults/${v.dbId}/proposals`,
      {
        title: `Distribute ${amount} ${native ? 'ETH' : asset}`,
        description: 'V13 e2e distribution',
        type: 'distribution',
        startDate: new Date().toISOString(),
        duration: Number(durationMs),
        distributionAsset: native ? '0x0000000000000000000000000000000000000000' : asset,
        distributionAmount: native ? parseEther(amount).toString() : amount,
      },
      token
    )
  );
  const id = res.proposal?.id;
  if (res.evmPayment) {
    const { client } = walletOf(who);
    const h = await client.sendTransaction({ to: res.evmPayment.to, value: BigInt(res.evmPayment.value) });
    await waitTx(h);
    await api('POST', `/governance/proposals/${id}/submit-fee-payment`, { txHash: h }, token);
    console.log(`fee paid ${res.evmPayment.value} wei tx=${h}`);
  }
  console.log(`proposal ${id}`);
}

async function proposeExpansion(name: string, who: string, durationMs: string) {
  const v = loadState()[name];
  const token = await login(who);
  const res = unwrap(
    await api(
      'POST',
      `/governance/vaults/${v.dbId}/proposals`,
      {
        title: `Expansion ${Number(durationMs) / 3600000} h`,
        description: 'V13 e2e expansion',
        type: 'expansion',
        startDate: new Date().toISOString(),
        duration: 300000,
        expansionEvmAssets: [{ contractAddress: TUSDC, label: 'tUSDC' }],
        expansionDuration: Number(durationMs),
        expansionNoLimit: false,
        expansionNoMax: true,
        expansionPriceType: 'limit',
        expansionLimitPrice: 1,
      },
      token
    )
  );
  const id = res.proposal?.id;
  if (res.evmPayment) {
    const { client } = walletOf(who);
    const h = await client.sendTransaction({ to: res.evmPayment.to, value: BigInt(res.evmPayment.value) });
    await waitTx(h);
    await api('POST', `/governance/proposals/${id}/submit-fee-payment`, { txHash: h }, token);
  }
  console.log(`proposal ${id}`);
}

/** Pay the fee of an already-created unpaid proposal. */
async function payProposal(proposalId: string, who: string, to: string, value: string) {
  const token = await login(who);
  const { client } = walletOf(who);
  const h = await client.sendTransaction({ to, value: BigInt(value) });
  await waitTx(h);
  await api('POST', `/governance/proposals/${proposalId}/submit-fee-payment`, { txHash: h }, token);
  console.log(`fee paid tx=${h}`);
}

async function vote(proposalId: string, who: string, choice = 'yes') {
  // EVM votes pay governance-fees.evm.votingFee to the fee recipient (the testnet admin) first.
  const fees = await api('GET', '/governance/governance-fees?chainType=robinhood');
  let feeTxHash: Hex | undefined;
  if (BigInt(fees.evm?.votingFee ?? 0) > 0n) {
    const { client } = walletOf(who);
    feeTxHash = await client.sendTransaction({
      to: '0x87F86a948f5369240E57a3C8BbED5E8E57F8da7e',
      value: BigInt(fees.evm.votingFee),
    });
    await waitTx(feeTxHash);
  }
  const res = unwrap(
    await api('POST', `/governance/proposals/${proposalId}/vote`, { vote: choice, feeTxHash }, await login(who))
  );
  console.log(`${who} voted ${choice}: ${JSON.stringify(res).slice(0, 200)}`);
}

async function proposal(proposalId: string) {
  const res = unwrap(await api('GET', `/governance/proposals/${proposalId}`, undefined, await login('alice')));
  const p = res.proposal ?? res;
  console.log(
    `status=${p.status} executionError=${p.executionError ?? '-'} evmDistribution=${JSON.stringify(p.metadata?.evmDistribution ?? null)}`
  );
  console.log(`evmDistributionTiming=${JSON.stringify(res.evmDistributionTiming ?? null)}`);
}

async function distributionAction(name: string, fn: 'approveDistribution' | 'cancelDistribution', id: string) {
  const address = await vaultAddress(name);
  const { client } = walletOf('dave');
  const h = await client.writeContract({ address, abi: VERIFIER_ABI, functionName: fn, args: [BigInt(id)] });
  await waitTx(h);
  console.log(`${fn}(${id}) on ${name} tx=${h}`);
}

// --------------------------------------------------------------------------- main

const [cmd, ...args] = process.argv.slice(2);
const run: Record<string, () => Promise<unknown>> = {
  create: () => create(args[0], args[1], args[2]),
  contribute: () => contributeOrAcquire(args[0], args[1], 'contribute', args[2]),
  acquire: () => contributeOrAcquire(args[0], args[1], 'acquire', args[2]),
  status: () => status(args[0]),
  'approve-root': () => verifier(args[0], 'approveAllocationRoot', args[1]),
  'cancel-root': () => verifier(args[0], 'cancelAllocationRoot', args[1]),
  wait: () => waitStatus(args[0], args[1], args[2]),
  'propose-dist': () => proposeDistribution(args[0], args[1], args[2], args[3], args[4]),
  vote: () => vote(args[0], args[1], args[2]),
  'propose-expansion': () => proposeExpansion(args[0], args[1], args[2]),
  'pay-proposal': () => payProposal(args[0], args[1], args[2], args[3]),
  proposal: () => proposal(args[0]),
  'approve-dist': () => distributionAction(args[0], 'approveDistribution', args[1]),
  'cancel-dist': () => distributionAction(args[0], 'cancelDistribution', args[1]),
  login: async () => console.log((await login(args[0] ?? 'alice')).slice(0, 20) + '…'),
};
if (!run[cmd]) {
  console.error(`commands: ${Object.keys(run).join(', ')}`);
  process.exit(1);
}
run[cmd]()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err.message ?? err);
    process.exit(1);
  });
