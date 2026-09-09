/**
 * Pure bigint termination-rate formulas for EVM vaults.
 *
 * These MUST agree with `Vault.sol` to the base unit. The contract re-checks
 * every bound below at commit time, so a mismatch here does not risk funds —
 * it just means `beginTermination` reverts. The point of duplicating the
 * arithmetic is to fail in the backend, with a readable error, instead of
 * burning a transaction.
 *
 * The model: one redemption RATE per distributable asset, expressed as asset
 * base units per `RATE_ONE` VT base units. A holder burning `bal` VT receives
 * `mulDiv(bal, rate, RATE_ONE)` of each asset, floored.
 *
 *   rate    = free * RATE_ONE / totalSupply
 *   implied = totalSupply * rate / RATE_ONE     (<= free, by construction)
 *
 * `implied` is re-derived rather than assumed equal to `free`: integer
 * division means `rate` is floored, so `implied` lands at or just below
 * `free`. That gap is the dust the sweep eventually collects.
 */

/**
 * Fixed-point scale for rates. Mirrors `Vault.sol#RATE_ONE`.
 *
 * `1e27`, NOT the `1e18` used by `adaPairVtPerNativeUnit` in `provideLiquidity`.
 * The larger scale protects precision: at `1e18`, a small-decimal asset against
 * a large VT supply truncates the rate itself to zero — e.g. 50,000 USDC
 * (`5e10` units) against a `1e30` VT supply gives `0`, paying every holder
 * nothing and sending the whole pot to the treasury at the deadline.
 */
export const RATE_ONE = 10n ** 27n;

/** Mirrors `Vault.sol#MIN_DISTRIBUTION_BPS`. */
export const MIN_DISTRIBUTION_BPS = 9_900n;

/** Mirrors `Vault.sol#MIN_SWEEP_DELAY`, in seconds. */
export const MIN_SWEEP_DELAY_SECONDS = 90n * 24n * 60n * 60n;

/** Mirrors `Vault.sol#MAX_TERMINATION_ASSETS`. */
export const MAX_TERMINATION_ASSETS = 16;

/** Mirrors `Vault.sol#MAX_WAIVED_ASSETS`. */
export const MAX_WAIVED_ASSETS = 8;

const BPS_DENOM = 10_000n;

export interface TerminationAssetInput {
  /** `0x0` = native, otherwise the ERC-20 address. */
  asset: `0x${string}`;
  /** Free balance in base units: custody minus every reserved liability. */
  free: bigint;
}

export interface TerminationRateRow {
  asset: `0x${string}`;
  rate: bigint;
  /** What the whole supply redeeming would draw: `supply * rate / RATE_ONE`. */
  implied: bigint;
  free: bigint;
  /** `implied / free` in bips — how much of the balance is actually distributed. */
  distributionBps: bigint;
}

export interface TerminationRateResult {
  rows: TerminationRateRow[];
  /** Assets that cannot be distributed and must be waived or resolved. */
  undistributable: Array<{ asset: `0x${string}`; free: bigint; reason: string }>;
}

/**
 * Floor of `a * b / d`, matching Solidity's `Math.mulDiv`. Native bigints are
 * arbitrary precision, so there is no intermediate-overflow concern here — the
 * contract needs `mulDiv` for that reason, we do not.
 */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('mulDiv: division by zero');
  return (a * b) / d;
}

/** What a holder of `vtAmount` receives of an asset carrying `rate`. */
export function payoutFor(vtAmount: bigint, rate: bigint): bigint {
  return mulDiv(vtAmount, rate, RATE_ONE);
}

/**
 * Compute the rate for each asset, splitting out the ones that cannot be
 * distributed at all.
 *
 * An asset lands in `undistributable` when:
 *   - its free balance is zero (nothing to hand out), or
 *   - the rate or its implied total floors to zero — the balance is too small
 *     relative to the VT supply to express as a rate. `RATE_ONE = 1e27` makes
 *     this rare, but it is not impossible for a tiny balance against a huge
 *     supply, which is why the contract rejects it rather than trusting the
 *     constant.
 *
 * Callers must either waive those assets explicitly or resolve them before
 * committing; leaving one in custody uncovered makes `beginTermination` revert
 * with `TerminationAssetUncovered`.
 */
export function computeTerminationRates(assets: TerminationAssetInput[], totalSupply: bigint): TerminationRateResult {
  if (totalSupply <= 0n) throw new Error('computeTerminationRates: totalSupply must be positive');

  const rows: TerminationRateRow[] = [];
  const undistributable: Array<{ asset: `0x${string}`; free: bigint; reason: string }> = [];

  for (const { asset, free } of assets) {
    if (free <= 0n) {
      undistributable.push({ asset, free, reason: 'zero free balance' });
      continue;
    }

    const rate = mulDiv(free, RATE_ONE, totalSupply);
    if (rate === 0n) {
      undistributable.push({ asset, free, reason: 'rate truncates to zero against the VT supply' });
      continue;
    }

    const implied = mulDiv(totalSupply, rate, RATE_ONE);
    if (implied === 0n) {
      undistributable.push({ asset, free, reason: 'implied total truncates to zero' });
      continue;
    }

    rows.push({ asset, rate, implied, free, distributionBps: mulDiv(implied, BPS_DENOM, free) });
  }

  return { rows, undistributable };
}

export interface RateValidationError {
  asset: `0x${string}`;
  reason: string;
}

/**
 * Re-run every bound `Vault.sol#beginTermination` applies, so a bad commit
 * fails here with a readable message instead of as an opaque on-chain revert.
 */
export function validateTerminationRates(rows: TerminationRateRow[]): RateValidationError[] {
  const errors: RateValidationError[] = [];
  const seen = new Set<string>();

  if (rows.length === 0) {
    errors.push({ asset: '0x0000000000000000000000000000000000000000', reason: 'no assets to distribute' });
  }
  if (rows.length > MAX_TERMINATION_ASSETS) {
    errors.push({
      asset: '0x0000000000000000000000000000000000000000',
      reason: `${rows.length} assets exceeds MAX_TERMINATION_ASSETS (${MAX_TERMINATION_ASSETS})`,
    });
  }

  for (const r of rows) {
    const key = r.asset.toLowerCase();
    if (seen.has(key)) errors.push({ asset: r.asset, reason: 'duplicate asset' });
    seen.add(key);

    if (r.rate === 0n) errors.push({ asset: r.asset, reason: 'rate is zero' });
    if (r.implied === 0n) errors.push({ asset: r.asset, reason: 'implied total is zero' });
    if (r.implied > r.free) {
      errors.push({ asset: r.asset, reason: `implied ${r.implied} exceeds free balance ${r.free}` });
    }
    if (r.distributionBps < MIN_DISTRIBUTION_BPS) {
      errors.push({
        asset: r.asset,
        reason: `distributes only ${r.distributionBps} bps of the free balance, below the ${MIN_DISTRIBUTION_BPS} floor`,
      });
    }
  }

  return errors;
}
