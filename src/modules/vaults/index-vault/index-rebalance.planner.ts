// Relative on purpose: jest in this repo has no `@/` module mapper.
import { BPS } from '../../../types/index-vault.types';

/**
 * Pure basket math for index-weighted vaults. No I/O: callers read balances and
 * native valuations from chain, this decides what to trade.
 *
 * Model: NAV = free native + Σ free basket-token value (in wei). `reserveBps` of
 * NAV stays in native; basket weights apply to the rest. Every trade routes
 * through native (token → native → token), which keeps each leg on the most
 * liquid pool and lets sells fund buys.
 */

export interface HoldingValue {
  /** Lowercase ERC-20 address. */
  asset: string;
  /** Balance the vault may spend (`availableErc20ForOperations`). */
  balance: bigint;
  /** Estimated native value of `balance`, in wei. */
  valueNative: bigint;
}

export interface PortfolioState {
  /** `availableNativeForOperations`. */
  nativeAvailable: bigint;
  holdings: HoldingValue[];
}

export interface WeightTarget {
  asset: string;
  weightBps: number;
}

export interface PlanOptions {
  reserveBps: number;
  driftToleranceBps: number;
  /** Legs below this native value are dust and never traded. */
  minTradeNative: bigint;
}

export interface PlannedSell {
  asset: string;
  amountIn: bigint;
  valueNative: bigint;
  /** True when the asset left the basket and the whole balance is sold. */
  exit: boolean;
}

export interface PlannedBuy {
  asset: string;
  nativeIn: bigint;
}

export interface AllocationRow {
  asset: string;
  targetBps: number;
  actualBps: number;
  valueNative: bigint;
  targetValueNative: bigint;
  /** actual − target, in bps of NAV. */
  driftBps: number;
}

export function computeNav(state: PortfolioState): bigint {
  return state.holdings.reduce((sum, h) => sum + h.valueNative, state.nativeAvailable);
}

export function reserveNative(nav: bigint, reserveBps: number): bigint {
  return (nav * BigInt(reserveBps)) / BigInt(BPS);
}

export function targetValue(nav: bigint, reserveBps: number, weightBps: number): bigint {
  const investable = nav - reserveNative(nav, reserveBps);
  return (investable * BigInt(weightBps)) / BigInt(BPS);
}

function bpsOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * BigInt(BPS)) / whole);
}

function weightMap(targets: WeightTarget[]): Map<string, number> {
  return new Map(targets.map(t => [t.asset.toLowerCase(), t.weightBps]));
}

/**
 * Current vs target allocation per basket asset, plus assets held outside the
 * basket (target 0). Reserve drift is reported separately by the caller.
 */
export function computeAllocation(
  state: PortfolioState,
  targets: WeightTarget[],
  reserveBps: number
): { nav: bigint; rows: AllocationRow[]; reserveActualBps: number } {
  const nav = computeNav(state);
  const weights = weightMap(targets);
  const held = new Map(state.holdings.map(h => [h.asset.toLowerCase(), h]));
  const assets = new Set([...weights.keys(), ...held.keys()]);

  const rows: AllocationRow[] = [];
  for (const asset of assets) {
    const weightBps = weights.get(asset) ?? 0;
    const valueNative = held.get(asset)?.valueNative ?? 0n;
    if (weightBps === 0 && valueNative === 0n) continue;
    const target = targetValue(nav, reserveBps, weightBps);
    // Target bps are expressed against NAV so rows and reserve sum to 100%.
    const targetBps = Math.round((weightBps * (BPS - reserveBps)) / BPS);
    const actualBps = bpsOf(valueNative, nav);
    rows.push({ asset, targetBps, actualBps, valueNative, targetValueNative: target, driftBps: actualBps - targetBps });
  }

  return { nav, rows, reserveActualBps: bpsOf(state.nativeAvailable, nav) };
}

/**
 * Sell legs: assets that left the basket (whole balance) and assets over target
 * by more than the drift tolerance (down to target).
 */
export function planSells(state: PortfolioState, targets: WeightTarget[], opts: PlanOptions): PlannedSell[] {
  const nav = computeNav(state);
  if (nav === 0n) return [];
  const weights = weightMap(targets);
  const tolerance = (nav * BigInt(opts.driftToleranceBps)) / BigInt(BPS);

  const sells: PlannedSell[] = [];
  for (const h of state.holdings) {
    if (h.balance === 0n || h.valueNative === 0n) continue;
    const asset = h.asset.toLowerCase();
    const weightBps = weights.get(asset);

    if (weightBps === undefined) {
      if (h.valueNative < opts.minTradeNative) continue;
      sells.push({ asset, amountIn: h.balance, valueNative: h.valueNative, exit: true });
      continue;
    }

    const excess = h.valueNative - targetValue(nav, opts.reserveBps, weightBps);
    if (excess <= tolerance || excess < opts.minTradeNative) continue;
    const amountIn = (h.balance * excess) / h.valueNative;
    if (amountIn === 0n) continue;
    sells.push({ asset, amountIn, valueNative: excess, exit: false });
  }
  return sells;
}

/**
 * Buy legs: basket assets under target by more than the drift tolerance, funded
 * by native above the reserve. When the free native cannot cover every
 * deficit, all buys scale down pro rata so relative weights are preserved.
 */
export function planBuys(state: PortfolioState, targets: WeightTarget[], opts: PlanOptions): PlannedBuy[] {
  const nav = computeNav(state);
  if (nav === 0n) return [];
  const tolerance = (nav * BigInt(opts.driftToleranceBps)) / BigInt(BPS);
  const spendable = state.nativeAvailable - reserveNative(nav, opts.reserveBps);
  if (spendable <= 0n) return [];

  const held = new Map(state.holdings.map(h => [h.asset.toLowerCase(), h.valueNative]));
  const wants: PlannedBuy[] = [];
  for (const t of targets) {
    const asset = t.asset.toLowerCase();
    const deficit = targetValue(nav, opts.reserveBps, t.weightBps) - (held.get(asset) ?? 0n);
    if (deficit <= tolerance) continue;
    wants.push({ asset, nativeIn: deficit });
  }

  const totalWanted = wants.reduce((sum, w) => sum + w.nativeIn, 0n);
  const scaled =
    totalWanted > spendable ? wants.map(w => ({ ...w, nativeIn: (w.nativeIn * spendable) / totalWanted })) : wants;

  return scaled.filter(w => w.nativeIn >= opts.minTradeNative && w.nativeIn > 0n);
}

export interface WeightValidationInput {
  weightsBps: number[];
  maxAssets: number;
  minWeightBps: number;
}

/** Returns a human-readable problem, or null when the weights form a valid basket. */
export function validateWeights({ weightsBps, maxAssets, minWeightBps }: WeightValidationInput): string | null {
  if (weightsBps.length === 0) return 'The basket needs at least one asset';
  if (weightsBps.length > maxAssets) return `The basket can hold at most ${maxAssets} assets`;
  if (weightsBps.some(w => !Number.isInteger(w))) return 'Weights must be whole basis points';
  if (weightsBps.some(w => w < minWeightBps)) return `Every asset needs a weight of at least ${minWeightBps / 100}%`;
  const total = weightsBps.reduce((a, b) => a + b, 0);
  if (total !== BPS) return `Weights must add up to 100% (currently ${total / 100}%)`;
  return null;
}
