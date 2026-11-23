import type { Abi } from 'viem';

import { findEvmProtocolVersionByFactory } from './evm-protocol-versions';
import { TIME_WINDOW, VAULT_ABI } from './vault.abi';

/**
 * V13 vaults (vault-contract-solidity `feat/v13`). Differences the backend has to follow:
 *
 *  - Creation: `VaultConfig` gains `economics` (supply, acquirer %, LP %, LP mode, expansion cap),
 *    fixed for the vault's life, and `CycleConfig` gains `nativeVtPrice`, `assetVtPrices`, `vtCap`.
 *    Both change the config hash and the `createVault` / `openCycle` selectors.
 *  - Raise close: the contract sizes the acquirer pool, the LP carve-out and the root's bounds
 *    itself. The root only splits the asset contributors' VT and native; acquirers claim their
 *    share on-chain (`claimOnchainAllocation`), so they are not leaves.
 *  - A root with anything in it opens for claims after `factory.allocationDelay()` (or when the
 *    verifier approves it); a guardian, pauser or verifier can cancel it before that.
 *  - LP: no technical cycle. `provideLiquidity` takes its price and ETH budget from the vault
 *    (`lpVtPerNative`, `lpNativeBudget`). FromSale vaults first sell an LP slice of each token
 *    with `swapForLp`.
 *  - Distributions: pro-rata only (no Merkle mode), claimable after `factory.distributionDelay()`
 *    unless the verifier approves earlier; cancellable while pending.
 *  - Expansions: at most `maxExpansionBps` of supply each, open for at least 24 h.
 *
 * Every branch keys off the vault's protocol version, so V8–V12 vaults are untouched.
 */
export const EVM_V13_VERSION = 13;

export const isV13Version = (version: number | null | undefined): boolean =>
  version != null && version >= EVM_V13_VERSION;

export const vaultIsV13 = (vault: { evm_protocol_version?: number | null }): boolean =>
  isV13Version(vault.evm_protocol_version);

/** Mirrors `Vault.MIN_EXPANSION_WINDOW`: a V13 expansion that mints VT stays open this long. */
export const V13_MIN_EXPANSION_WINDOW_SEC = 24n * 60n * 60n;

/**
 * Earliest unix time (s) a V13 expansion cycle can be closed: `closeCycle` reverts with
 * `ExpansionWindowTooShort` before `openedAt + 24h` unless the on-chain VT cap is full (not
 * tracked here, so callers wait the full 24 h). Null when the rule does not apply.
 */
export const v13ExpansionEarliestClose = (
  vault: { evm_protocol_version?: number | null },
  isExpansionCycle: boolean,
  openedAt: bigint
): bigint | null =>
  vaultIsV13(vault) && isExpansionCycle && openedAt > 0n ? openedAt + V13_MIN_EXPANSION_WINDOW_SEC : null;

/** Whether vaults created through `factory` are V13 (the factory must be registered). */
export const factoryIsV13 = (chainId: number, factory: string | null | undefined): boolean =>
  isV13Version(findEvmProtocolVersionByFactory(chainId, factory)?.version);

/** Mirrors `VaultTypes.LpMode`. */
export enum EvmLpMode {
  None = 0,
  FromAcquire = 1,
  FixedPrice = 2,
  FromSale = 3,
}

export const V13_BPS = 10_000;

// -----------------------------------------------------------------------------
// ABI
// -----------------------------------------------------------------------------

export const CYCLE_CONFIG_V13_COMPONENTS = [
  { name: 'assetWindow', type: 'tuple', components: TIME_WINDOW },
  { name: 'acquireWindow', type: 'tuple', components: TIME_WINDOW },
  { name: 'minAcquireThreshold', type: 'uint256' },
  { name: 'adaPairVtPerNativeUnit', type: 'uint256' },
  { name: 'assetWhitelist', type: 'address[]' },
  { name: 'contributorWhitelist', type: 'address[]' },
  { name: 'nativeVtPrice', type: 'uint256' },
  { name: 'assetVtPrices', type: 'uint256[]' },
  { name: 'vtCap', type: 'uint256' },
] as const;

export const VAULT_ECONOMICS_COMPONENTS = [
  { name: 'vtSupply', type: 'uint256' },
  { name: 'acquirerBps', type: 'uint16' },
  { name: 'lpBps', type: 'uint16' },
  { name: 'lpMode', type: 'uint8' },
  { name: 'lpVtPerNative', type: 'uint256' },
  { name: 'maxExpansionBps', type: 'uint16' },
] as const;

const SWAP_PARAMS_COMPONENTS = [
  { name: 'operationId', type: 'bytes32' },
  { name: 'adapter', type: 'address' },
  { name: 'assetIn', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'assetOut', type: 'address' },
  { name: 'minAmountOut', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'route', type: 'bytes' },
] as const;

const view = (name: string, inputs: readonly object[], outputs: readonly object[]) => ({
  type: 'function',
  stateMutability: 'view',
  name,
  inputs,
  outputs,
});
const write = (name: string, inputs: readonly object[], outputs: readonly object[] = []) => ({
  type: 'function',
  stateMutability: 'nonpayable',
  name,
  inputs,
  outputs,
});
const u256 = (name: string) => ({ name, type: 'uint256' });
const addr = (name: string) => ({ name, type: 'address' });

/** Entries whose V13 shape differs from {@link VAULT_ABI} (same name, other selector or outputs). */
const REPLACED = new Set(['openCycle', 'getDistribution', 'openDistributionMerkle', 'claimDistributionWithProofFor']);

const V13_ENTRIES = [
  write('openCycle', [{ name: 'cycle', type: 'tuple', components: CYCLE_CONFIG_V13_COMPONENTS }], [u256('')]),
  view(
    'getDistribution',
    [u256('distributionId')],
    [
      {
        name: '',
        type: 'tuple',
        components: [
          addr('asset'),
          { name: 'timepoint', type: 'uint48' },
          u256('netPot'),
          u256('supply'),
          u256('paid'),
          u256('released'),
          { name: 'openedAt', type: 'uint64' },
          { name: 'deadline', type: 'uint64' },
          // V13 inserted these before `swept` (order as in Vault.DistributionData).
          { name: 'activatesAt', type: 'uint64' },
          { name: 'cancelled', type: 'bool' },
          { name: 'approved', type: 'bool' },
          addr('lpSource'),
          { name: 'swept', type: 'bool' },
        ],
      },
    ]
  ),
  write('claimOnchainAllocation', [u256('cycleId'), addr('account')], [u256('vt')]),
  view('onchainEntitlement', [u256('cycleId'), addr('account')], [u256('vt'), { name: 'claimed', type: 'bool' }]),
  view(
    'cycleV13',
    [u256('cycleId')],
    [
      u256('vtCap'),
      u256('fixedVtTotal'),
      u256('acquirerPool'),
      u256('rootVtMax'),
      u256('rootNativeMax'),
      { name: 'rootActivatesAt', type: 'uint64' },
      { name: 'rootCancelled', type: 'bool' },
      { name: 'rootApproved', type: 'bool' },
    ]
  ),
  view('economics', [], [{ name: '', type: 'tuple', components: VAULT_ECONOMICS_COMPONENTS }]),
  view('isCycleContributor', [u256('cycleId'), addr('account')], [{ name: '', type: 'bool' }]),
  view('lpVtPerNative', [], [u256('')]),
  view('lpNativeBudget', [], [u256('')]),
  view('lpSaleProceeds', [], [u256('')]),
  view('raiseCycleId', [], [u256('')]),
  view('lpSeeded', [], [{ name: '', type: 'bool' }]),
  write('swapForLp', [{ name: 'p', type: 'tuple', components: SWAP_PARAMS_COMPONENTS }], [u256('netOut')]),
  view('lpSliceTokens', [], [{ name: '', type: 'address[]' }]),
  view('lpSlice', [addr('token')], [u256('slice'), u256('sold')]),
  view('lpSaleVt', [], [u256('')]),
  view('lpRateActivatesAt', [], [{ name: '', type: 'uint64' }]),
  view('lpRateCancelled', [], [{ name: '', type: 'bool' }]),
  write('proposeLpRate', [], [u256('rate')]),
  write('approveLpRate', []),
  write('cancelLpRate', []),
  write('recommitAllocationRoot', [
    u256('cycleId'),
    { name: 'allocationRoot', type: 'bytes32' },
    { name: 'valuationHash', type: 'bytes32' },
    u256('totalVtAllocation'),
    u256('totalNativeAllocation'),
  ]),
  {
    type: 'event',
    name: 'OnchainAllocationClaimed',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'vtAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CyclePoolsSet',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'acquirerPool', type: 'uint256', indexed: false },
      { name: 'rootVtMax', type: 'uint256', indexed: false },
      { name: 'rootNativeMax', type: 'uint256', indexed: false },
      { name: 'rootActivatesAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AllocationRootCancelled',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'DistributionCancelled',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'by', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'LpRateProposed',
    inputs: [
      { name: 'rate', type: 'uint256', indexed: false },
      { name: 'proceeds', type: 'uint256', indexed: false },
      { name: 'activatesAt', type: 'uint256', indexed: false },
    ],
  },
  { type: 'event', name: 'LpRateApproved', inputs: [{ name: 'by', type: 'address', indexed: true }] },
  { type: 'event', name: 'LpRateCancelled', inputs: [{ name: 'by', type: 'address', indexed: true }] },
] as const;

/** The vault ABI for V13 vaults: {@link VAULT_ABI} with the changed entries swapped out. */
export const VAULT_V13_ABI = [
  ...(VAULT_ABI as readonly { type: string; name?: string }[]).filter(
    e => !(e.type === 'function' && e.name && REPLACED.has(e.name))
  ),
  ...V13_ENTRIES,
] as unknown as Abi;

/** The ABI to talk to `vault` with. */
export const vaultAbiFor = (vault: { evm_protocol_version?: number | null }): Abi =>
  vaultIsV13(vault) ? VAULT_V13_ABI : (VAULT_ABI as unknown as Abi);

// -----------------------------------------------------------------------------
// Economics (fixed at creation)
// -----------------------------------------------------------------------------

export interface EvmVaultEconomics {
  vtSupply: bigint;
  acquirerBps: number;
  lpBps: number;
  lpMode: EvmLpMode;
  lpVtPerNative: bigint;
  maxExpansionBps: number;
}

export interface V13EconomicsInput {
  /** Whole VT (the form's `ftTokenSupply`). */
  ftTokenSupply: number | string;
  vtDecimals: number;
  /** Percent, 0–100 (the form's `tokensForAcquires`). */
  tokensForAcquiresPct: number | string;
  /** Percent, 0–100 (the form's `liquidityPoolContribution`). */
  lpPct: number | string;
  maxExpansionBps: number;
}

const pctToBps = (pct: number | string): number => {
  const bps = Math.round(Number(pct ?? 0) * 100);
  if (!Number.isFinite(bps) || bps < 0 || bps > V13_BPS) throw new Error(`percent out of range: ${pct}`);
  return bps;
};

/**
 * The vault's economics from the creation form. LP mode:
 *  - no LP share → None;
 *  - acquirers → FromAcquire (price and ETH from the raise, as the backend priced it before V13);
 *  - asset-only vault → FromSale (sell the LP share of every token; price from the sale).
 */
export function buildV13Economics(input: V13EconomicsInput): EvmVaultEconomics {
  const supply = BigInt(Math.round(Number(input.ftTokenSupply)));
  if (supply <= 0n) throw new Error('ftTokenSupply must be > 0');
  const acquirerBps = pctToBps(input.tokensForAcquiresPct);
  const lpBps = pctToBps(input.lpPct);
  if (!Number.isInteger(input.maxExpansionBps) || input.maxExpansionBps < 0 || input.maxExpansionBps > V13_BPS) {
    throw new Error(`maxExpansionBps out of range: ${input.maxExpansionBps}`);
  }
  let lpMode = EvmLpMode.None;
  if (lpBps > 0) {
    // FixedPrice is refused by the V13 contract (audit F-04).
    lpMode = acquirerBps > 0 ? EvmLpMode.FromAcquire : EvmLpMode.FromSale;
  }
  return {
    vtSupply: supply * 10n ** BigInt(input.vtDecimals),
    acquirerBps,
    lpBps,
    lpMode,
    lpVtPerNative: 0n,
    maxExpansionBps: input.maxExpansionBps,
  };
}

// -----------------------------------------------------------------------------
// Raise close (mirrors Vault._setPoolsAndCheck / _firstCycleLp)
// -----------------------------------------------------------------------------

const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;

export interface V13RaisePools {
  /** VT the acquirers share on-chain, pro rata to native. 0 when nothing was raised. */
  acquirerPool: bigint;
  /** Most VT the root may allocate (asset contributors). */
  rootVtMax: bigint;
  /** Most native the root may allocate (asset contributors). */
  rootNativeMax: bigint;
  /** FromAcquire: the pool's VT and ETH. FromSale: the carved-out VT (ETH comes from the sale). */
  lpVt: bigint;
  lpNative: bigint;
  /** VT per 1e18 wei the pool is seeded at; 0 until FromSale's sale is done. */
  lpRate: bigint;
}

/**
 * What `closeCycle` fixes for a vault's raise, from the raise and the contribution fee. The
 * backend's root must stay within `rootVtMax` / `rootNativeMax` or the close reverts.
 */
export function computeV13RaisePools(
  e: EvmVaultEconomics,
  raised: bigint,
  contributionFee: bigint,
  /** FromSale: whether the vault holds any ERC-20 at close (else nothing is carved out). */
  hasSliceTokens = true
): V13RaisePools {
  const netRaised = raised - contributionFee;
  const BPS = BigInt(V13_BPS);
  let lpVt = 0n;
  let lpNative = 0n;
  let lpRate = 0n;

  if (e.lpMode === EvmLpMode.FromAcquire && e.lpBps > 0 && e.acquirerBps > 0 && raised > 0n) {
    const fdv = mulDiv(raised, BPS, BigInt(e.acquirerBps));
    lpNative = mulDiv(fdv, BigInt(e.lpBps), 2n * BPS);
    lpVt = mulDiv(e.vtSupply, BigInt(e.lpBps), 2n * BPS);
    if (lpNative > netRaised) {
      lpNative = netRaised;
      lpVt = mulDiv(lpNative, e.vtSupply, fdv);
    }
    if (lpNative === 0n || lpVt === 0n) {
      lpNative = 0n;
      lpVt = 0n;
    } else {
      lpRate = mulDiv(lpVt, 10n ** 18n, lpNative);
      lpVt = mulDiv(lpNative, lpRate, 10n ** 18n);
    }
  }

  // FromSale, Cardano math: lp%/2 of the supply is carved out for the pool; its ETH
  // comes later from selling lp%/2 of every token (`swapForLp`).
  if (e.lpMode === EvmLpMode.FromSale && e.lpBps > 0 && hasSliceTokens) {
    lpVt = mulDiv(e.vtSupply, BigInt(e.lpBps), 2n * BPS);
  }
  const avail = e.vtSupply - lpVt;
  const toAcquirers = mulDiv(avail, BigInt(e.acquirerBps), BPS);

  return {
    acquirerPool: raised === 0n ? 0n : toAcquirers,
    rootVtMax: avail - toAcquirers,
    rootNativeMax: netRaised - lpNative,
    lpVt,
    lpNative,
    lpRate,
  };
}

/** `claimOnchainAllocation`'s amount for one acquirer: floor(pool × native / raised). */
export const v13AcquirerVt = (acquirerPool: bigint, nativeOf: bigint, raised: bigint): bigint =>
  raised === 0n ? 0n : mulDiv(acquirerPool, nativeOf, raised);

/**
 * FromSale price, as `proposeLpRate` fixes it once every slice is sold (Cardano math):
 * the carved-out `lpSaleVt` (lp%/2 of vtSupply) for all of the sale's ETH.
 */
export const v13FromSaleRate = (lpSaleVt: bigint, proceeds: bigint): bigint =>
  proceeds === 0n ? 0n : mulDiv(lpSaleVt, 10n ** 18n, proceeds);

/** The slice of `held` that FromSale must sell for the pool: lp%/2 (floor, as the contract). */
export const v13LpSlice = (held: bigint, lpBps: number): bigint => mulDiv(held, BigInt(lpBps), 2n * BigInt(V13_BPS));

/** Whether a V13 root may be claimed now (`cycleV13` read). */
export const v13RootOpen = (c: { rootActivatesAt: bigint | number; rootCancelled: boolean; rootApproved: boolean }) =>
  !c.rootCancelled && (c.rootApproved || BigInt(c.rootActivatesAt) <= BigInt(Math.floor(Date.now() / 1000)));

export type V13CycleView = {
  vtCap: bigint;
  fixedVtTotal: bigint;
  acquirerPool: bigint;
  rootVtMax: bigint;
  rootNativeMax: bigint;
  rootActivatesAt: bigint;
  rootCancelled: boolean;
  rootApproved: boolean;
};

/** Decodes the `cycleV13` tuple viem returns as an array. */
export const toV13CycleView = (r: readonly unknown[]): V13CycleView => ({
  vtCap: r[0] as bigint,
  fixedVtTotal: r[1] as bigint,
  acquirerPool: r[2] as bigint,
  rootVtMax: r[3] as bigint,
  rootNativeMax: r[4] as bigint,
  rootActivatesAt: BigInt(r[5] as bigint | number),
  rootCancelled: r[6] as boolean,
  rootApproved: r[7] as boolean,
});

// -----------------------------------------------------------------------------
// Status reads for the API (cached: vault and proposal pages poll)
// -----------------------------------------------------------------------------

type V13ReadClient = { readContract: (args: any) => Promise<unknown> };

const STATUS_TTL_MS = 30_000;
const statusCache = new Map<string, { at: number; value: unknown }>();

async function cachedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value as T;
  const value = await read();
  statusCache.set(key, { at: Date.now(), value });
  return value;
}

/** Where a closed V13 cycle's allocation root stands, for the vault page. */
export interface V13RootStatus {
  cycleId: string;
  /** Unix seconds; claims of the root's leaves open then (0 = the cycle is not closed). */
  rootActivatesAt: number;
  rootApproved: boolean;
  rootCancelled: boolean;
  /** Root closed, not cancelled, not open yet. */
  rootPending: boolean;
}

export async function readV13RootStatus(
  client: V13ReadClient,
  vaultAddress: string,
  cycleId: bigint
): Promise<V13RootStatus> {
  return cachedRead(`root:${vaultAddress.toLowerCase()}:${cycleId}`, async () => {
    const view = toV13CycleView(
      (await client.readContract({
        address: vaultAddress,
        abi: VAULT_V13_ABI,
        functionName: 'cycleV13',
        args: [cycleId],
      })) as readonly unknown[]
    );
    const activatesAt = Number(view.rootActivatesAt);
    return {
      cycleId: cycleId.toString(),
      rootActivatesAt: activatesAt,
      rootApproved: view.rootApproved,
      rootCancelled: view.rootCancelled,
      rootPending: activatesAt > 0 && !view.rootCancelled && !v13RootOpen(view),
    };
  });
}

/** A V13 distribution's timing, for the proposal page. */
export interface V13DistributionTiming {
  /** Unix seconds: claims open (earlier if approved). */
  activatesAt: number;
  /** Unix seconds: claims close. */
  deadline: number;
  approved: boolean;
  cancelled: boolean;
  pending: boolean;
}

export async function readV13DistributionTiming(
  client: V13ReadClient,
  vaultAddress: string,
  distributionId: bigint
): Promise<V13DistributionTiming> {
  return cachedRead(`dist:${vaultAddress.toLowerCase()}:${distributionId}`, async () => {
    const d = (await client.readContract({
      address: vaultAddress,
      abi: VAULT_V13_ABI,
      functionName: 'getDistribution',
      args: [distributionId],
    })) as { activatesAt: bigint; deadline: bigint; approved: boolean; cancelled: boolean };
    const activatesAt = Number(d.activatesAt);
    return {
      activatesAt,
      deadline: Number(d.deadline),
      approved: d.approved,
      cancelled: d.cancelled,
      pending: !d.cancelled && !d.approved && activatesAt * 1000 > Date.now(),
    };
  });
}
