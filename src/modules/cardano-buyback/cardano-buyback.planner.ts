/**
 * Pure buyback math for the Cardano L4VA buyback. No I/O: the service reads
 * wallet balances and DexHunter quotes, this decides whether and how much to
 * swap, whether a quote is acceptable, and how bought L4VA is split.
 *
 * Mirrors the EVM `BuybackExecutor` (vault-contract-solidity/src/BuybackExecutor.sol):
 * bought L4VA goes 25% burn / 25% treasury / 50% operations, operations
 * absorbing rounding dust. All amounts are base units (lovelace, L4VA with
 * decimals) as bigint.
 */

export const BPS = 10_000n;
export const LOVELACE_PER_ADA = 1_000_000n;

export interface BuybackSplitBps {
  burnBps: bigint;
  treasuryBps: bigint;
  // Operations receives the remainder.
}

export const DEFAULT_SPLIT: BuybackSplitBps = { burnBps: 2_500n, treasuryBps: 2_500n };

export interface BuybackSplit {
  burn: bigint;
  treasury: bigint;
  ops: bigint;
}

export function validateSplit(split: BuybackSplitBps): void {
  if (split.burnBps < 0n || split.treasuryBps < 0n) {
    throw new Error('Buyback split bps must be non-negative');
  }
  if (split.burnBps + split.treasuryBps > BPS) {
    throw new Error(`Buyback split exceeds 100%: burn ${split.burnBps} + treasury ${split.treasuryBps} bps`);
  }
}

export function splitL4va(amount: bigint, split: BuybackSplitBps = DEFAULT_SPLIT): BuybackSplit {
  validateSplit(split);
  if (amount < 0n) throw new Error('Buyback amount must be non-negative');

  const burn = (amount * split.burnBps) / BPS;
  const treasury = (amount * split.treasuryBps) / BPS;
  return { burn, treasury, ops: amount - burn - treasury };
}

/**
 * Split the buyback wallet's whole L4VA balance, or null when it is below
 * `minDistribute`. The wallet is dedicated, so every L4VA in it is buyback output.
 */
export function planDistribution(
  l4vaBalance: bigint,
  minDistribute: bigint,
  split: BuybackSplitBps = DEFAULT_SPLIT
): BuybackSplit | null {
  if (l4vaBalance <= 0n || l4vaBalance < minDistribute) return null;
  return splitL4va(l4vaBalance, split);
}

export interface SwapSizing {
  lovelaceBalance: bigint;
  /** Kept in the wallet for tx fees and min-UTxO of distribution outputs. */
  reserveLovelace: bigint;
  minSwapLovelace: bigint;
  /** Per-execution cap, limits single-order price impact. */
  maxSwapLovelace: bigint;
}

/** Lovelace to swap this cycle, or null when the spendable balance is below the minimum. */
export function planSwapAmount(s: SwapSizing): bigint | null {
  if (s.maxSwapLovelace <= 0n) throw new Error('maxSwapLovelace must be positive');
  if (s.minSwapLovelace > s.maxSwapLovelace) throw new Error('minSwapLovelace exceeds maxSwapLovelace');

  const available = s.lovelaceBalance - s.reserveLovelace;
  if (available <= 0n || available < s.minSwapLovelace) return null;
  return available < s.maxSwapLovelace ? available : s.maxSwapLovelace;
}

export interface QuoteCheckInput {
  lovelaceIn: bigint;
  /** Guaranteed output after slippage, L4VA base units. */
  minOut: bigint;
  /** Price impact of each DEX split, in percent (DexHunter units). */
  priceImpactsPct: number[];
  maxPriceImpactBps: bigint;
  /**
   * Governance floor: minimum L4VA base units per 1 ADA the swap must
   * guarantee. Counterpart of the EVM `referencePrice × (1 − maxSlippage)`.
   * 0 disables the check.
   */
  minL4vaPerAda: bigint;
}

export type QuoteCheckResult = { ok: true } | { ok: false; reason: string };

export function checkQuote(q: QuoteCheckInput): QuoteCheckResult {
  if (q.lovelaceIn <= 0n) return { ok: false, reason: 'Swap input must be positive' };
  if (q.minOut <= 0n) return { ok: false, reason: 'Quote returns no L4VA' };

  const worstImpactPct = q.priceImpactsPct.reduce((max, p) => (Number.isFinite(p) && p > max ? p : max), 0);
  const worstImpactBps = BigInt(Math.ceil(worstImpactPct * 100));
  if (worstImpactBps > q.maxPriceImpactBps) {
    return {
      ok: false,
      reason: `Price impact ${worstImpactPct}% exceeds max ${Number(q.maxPriceImpactBps) / 100}%`,
    };
  }

  // minOut / (lovelaceIn / 1e6) >= minL4vaPerAda, kept in integers.
  if (q.minL4vaPerAda > 0n && q.minOut * LOVELACE_PER_ADA < q.lovelaceIn * q.minL4vaPerAda) {
    return {
      ok: false,
      reason: `Quote ${(q.minOut * LOVELACE_PER_ADA) / q.lovelaceIn} L4VA/ADA (base units) is below floor ${q.minL4vaPerAda}`,
    };
  }

  return { ok: true };
}

/**
 * DexHunter quotes in display units (ADA, whole tokens). Convert to base units,
 * truncating anything finer than `decimals`.
 */
export function displayToBase(value: number | string, decimals: number): bigint {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid display amount: ${value}`);

  const fixed = n.toFixed(decimals + 2);
  const [whole, frac = ''] = fixed.split('.');
  return BigInt(whole + frac.slice(0, decimals).padEnd(decimals, '0'));
}

/** Base units → display number for DexHunter's `amount_in`. */
export function baseToDisplay(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = (amount % scale).toString().padStart(decimals, '0');
  return Number(decimals > 0 ? `${whole}.${frac}` : `${whole}`);
}
