/**
 * Pure bigint allocation formulas for EVM vaults.
 *
 * Mirrors the semantics of Cardano's DistributionCalculationService but uses
 * bigint arithmetic throughout so wei-scale values keep full precision.
 *
 *   contributor_share  = user_contributed_value / totalContributedValue
 *   acquirer_share     = user_native_raised    / totalNativeRaised
 *   vt_supply_available = ftTokenSupply * 10^ftDecimals  (LP carveout deferred)
 *
 *   vt_to_acquirers = vt_supply_available * assetsOfferedBps / 10_000
 *   vt_to_contribs  = vt_supply_available - vt_to_acquirers
 *
 *   per contributor: vt = vt_to_contribs   * contributor_share
 *                     native = totalNativeRaised * contributor_share
 *   per acquirer:    vt = vt_to_acquirers  * acquirer_share
 *                     native = 0
 *   (wallets who are both roles → summed)
 *
 * Percent inputs are in bips (basis points, 0-10000) so bigint math works
 * without rounding gymnastics.
 *
 * LP carveout is deferred to a later pass — this pass passes `0n` for
 * `lpVtAmount` / `lpNativeAmount`. When we wire in `provideLiquidity`,
 * subtract those from the pools BEFORE applying wallet shares.
 */

export interface EvmAllocationInputRow {
  contributor: `0x${string}`;
  /** Native (wei) contributed via contributeNative during Acquire window. */
  nativeRaised: bigint;
  /** Native-denominated total value of ERC-20/721/1155 contributions during Asset window. */
  contributedValue: bigint;
}

export interface EvmAllocationFormulaParams {
  rows: EvmAllocationInputRow[];
  /** Total VT supply in base units (i.e. supply * 10^decimals). */
  vtSupplyBaseUnits: bigint;
  /** Percentage of VT supply reserved for acquirers, in bips (0..10000). */
  assetsOfferedBps: number;
  /** Reserved VT that will go to the LP contract (deferred; pass 0n for now). */
  lpVtAmount?: bigint;
  /** Reserved native that will go to the LP contract (deferred; pass 0n for now). */
  lpNativeAmount?: bigint;
}

export interface EvmAllocationFormulaRow {
  contributor: `0x${string}`;
  vtAmount: bigint;
  nativeAmount: bigint;
}

export interface EvmAllocationFormulaResult {
  perWallet: EvmAllocationFormulaRow[];
  totalNativeRaised: bigint;
  totalContributedValue: bigint;
  totalVtAllocation: bigint;
  totalNativeAllocation: bigint;
  vtToAcquirers: bigint;
  vtToContributors: bigint;
}

/** Deterministic per-wallet allocation. Rows are returned sorted by contributor address. */
export function computeEvmAllocationRows(params: EvmAllocationFormulaParams): EvmAllocationFormulaResult {
  const { rows, vtSupplyBaseUnits, assetsOfferedBps } = params;
  const lpVtAmount = params.lpVtAmount ?? 0n;
  const lpNativeAmount = params.lpNativeAmount ?? 0n;

  if (assetsOfferedBps < 0 || assetsOfferedBps > 10_000) {
    throw new Error(`assetsOfferedBps must be in [0, 10000]; got ${assetsOfferedBps}`);
  }
  if (vtSupplyBaseUnits <= 0n) {
    throw new Error('vtSupplyBaseUnits must be > 0');
  }
  if (lpVtAmount > vtSupplyBaseUnits) {
    throw new Error('lpVtAmount exceeds vtSupplyBaseUnits');
  }

  // Aggregate per wallet — dedupe so a wallet contributing in both windows collapses.
  const merged = new Map<`0x${string}`, { nativeRaised: bigint; contributedValue: bigint }>();
  for (const r of rows) {
    const key = r.contributor.toLowerCase() as `0x${string}`;
    const cur = merged.get(key) ?? { nativeRaised: 0n, contributedValue: 0n };
    cur.nativeRaised += r.nativeRaised;
    cur.contributedValue += r.contributedValue;
    merged.set(key, cur);
  }

  const totalNativeRaised = Array.from(merged.values()).reduce((s, r) => s + r.nativeRaised, 0n);
  const totalContributedValue = Array.from(merged.values()).reduce((s, r) => s + r.contributedValue, 0n);

  const vtSupplyAvailable = vtSupplyBaseUnits - lpVtAmount;
  const vtToAcquirers = (vtSupplyAvailable * BigInt(assetsOfferedBps)) / 10_000n;
  const vtToContributors = vtSupplyAvailable - vtToAcquirers;

  // Native goes to contributors, minus LP carveout.
  const nativeToContributors = totalNativeRaised > lpNativeAmount ? totalNativeRaised - lpNativeAmount : 0n;

  // Sort deterministically so claim_index is stable across recomputes.
  const sortedEntries = Array.from(merged.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const perWallet: EvmAllocationFormulaRow[] = [];
  let sumVt = 0n;
  let sumNative = 0n;

  for (const [contributor, agg] of sortedEntries) {
    let vt = 0n;
    let native = 0n;

    // Contributor share of the asset pool.
    if (totalContributedValue > 0n && agg.contributedValue > 0n) {
      vt += (vtToContributors * agg.contributedValue) / totalContributedValue;
      if (nativeToContributors > 0n) {
        native += (nativeToContributors * agg.contributedValue) / totalContributedValue;
      }
    }

    // Acquirer share of the acquire pool.
    if (totalNativeRaised > 0n && agg.nativeRaised > 0n) {
      vt += (vtToAcquirers * agg.nativeRaised) / totalNativeRaised;
    }

    if (vt === 0n && native === 0n) continue;

    perWallet.push({ contributor, vtAmount: vt, nativeAmount: native });
    sumVt += vt;
    sumNative += native;
  }

  return {
    perWallet,
    totalNativeRaised,
    totalContributedValue,
    totalVtAllocation: sumVt,
    totalNativeAllocation: sumNative,
    vtToAcquirers,
    vtToContributors,
  };
}

export interface EvmLpCarveoutParams {
  /** Total VT supply in base units. */
  vtSupplyBaseUnits: bigint;
  /** Native (wei) raised in the Acquire window. */
  totalNativeRaised: bigint;
  /** Percentage of VT supply offered to acquirers, in bips (0..10000). */
  assetsOfferedBps: number;
  /** Vault `liquidity_pool_contribution`, in bips (0..10000). */
  lpBps: number;
}

export interface EvmLpCarveout {
  /** VT minted into the pool (base units). Subtract from the allocatable supply. */
  lpVtAmount: bigint;
  /** Native (wei) sent into the pool. Kept out of contributor payouts. */
  lpNativeAmount: bigint;
  /** `adaPairVtPerNativeUnit` for the LP cycle: VT per 1 native unit, 1e18-scaled. */
  rate: bigint;
  /** FDV in wei the pool price is derived from. */
  fdvNative: bigint;
}

/**
 * LP sizing, same model as Cardano `DistributionCalculationService.calculateLpTokens`:
 *
 *   fdv          = totalNativeRaised / assetsOffered%
 *   lpNative     = fdv    * lp% / 2
 *   lpVt         = supply * lp% / 2
 *   pool price   = lpNative / lpVt = fdv / supply
 *
 * If lpNative would exceed what was raised it is capped at the raise and lpVt
 * shrinks with it, so the pool price stays fdv / supply.
 *
 * Returns null when there is no pool to seed (LP 0%, nothing raised, or no
 * acquirers — without an acquire raise there is no native and no FDV anchor).
 */
export function computeEvmLpCarveout(params: EvmLpCarveoutParams): EvmLpCarveout | null {
  const { vtSupplyBaseUnits, totalNativeRaised, assetsOfferedBps, lpBps } = params;
  if (lpBps < 0 || lpBps > 10_000) throw new Error(`lpBps must be in [0, 10000]; got ${lpBps}`);
  if (lpBps === 0 || assetsOfferedBps <= 0 || totalNativeRaised <= 0n || vtSupplyBaseUnits <= 0n) return null;

  const fdvNative = (totalNativeRaised * 10_000n) / BigInt(assetsOfferedBps);
  let lpNativeAmount = (fdvNative * BigInt(lpBps)) / 20_000n;
  let lpVtAmount = (vtSupplyBaseUnits * BigInt(lpBps)) / 20_000n;

  if (lpNativeAmount > totalNativeRaised) {
    lpNativeAmount = totalNativeRaised;
    lpVtAmount = (lpNativeAmount * vtSupplyBaseUnits) / fdvNative;
  }
  if (lpNativeAmount === 0n || lpVtAmount === 0n) return null;

  const rate = (lpVtAmount * 10n ** 18n) / lpNativeAmount;
  // The vault mints floor(lpNative * rate / 1e18) VT, which never exceeds lpVtAmount.
  lpVtAmount = (lpNativeAmount * rate) / 10n ** 18n;

  return { lpVtAmount, lpNativeAmount, rate, fdvNative };
}
