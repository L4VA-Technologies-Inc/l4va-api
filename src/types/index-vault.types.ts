/**
 * Index-weighted vault (Robinhood / EVM).
 *
 * On `vault-contract-solidity` main there is no on-chain weight concept: the
 * vault only exposes position-less `Vault.swap`. Target weights, the cash / LP
 * reserve and rebalance cadence are backend-enforced (see
 * docs/HOW_THE_VAULT_WORKS.md §13c). Everything below is that backend model.
 */

/** Product-level vault archetype. Independent of the on-chain deployer archetype. */
export enum VaultArchetype {
  standard = 'standard',
  index_weighted = 'index_weighted',
}

export const BPS = 10_000;

/**
 * Hard cap on basket size. The vault can track at most 16 termination assets
 * (`MAX_TERMINATION_ASSETS`); every bought asset takes one slot permanently, so
 * leave headroom for the fee token, stablecoins and assets swapped out during
 * re-weights.
 */
export const INDEX_MAX_ASSETS = 10;

/** Smallest weight a basket asset may carry (1%). */
export const INDEX_MIN_WEIGHT_BPS = 100;

export const INDEX_DEFAULT_DRIFT_TOLERANCE_BPS = 200;
export const INDEX_DEFAULT_SLIPPAGE_BPS = 100;
export const INDEX_MAX_SLIPPAGE_BPS = 500;

export interface IndexTarget {
  /** Lowercase ERC-20 address. Native is never a basket target — it is the reserve. */
  assetAddress: string;
  symbol: string;
  name?: string | null;
  decimals: number;
  image?: string | null;
  weightBps: number;
}

export interface IndexConfig {
  /** Basket weights; sum to `BPS`. They apply to NAV after the reserve. */
  targets: IndexTarget[];
  /** Share of NAV kept in native (cash / future LP). */
  reserveBps: number;
  /** A leg is only traded when its value is off target by more than this share of NAV. */
  driftToleranceBps: number;
  slippageBps: number;
  /** Incremented on every governance re-weight. */
  version: number;
  updatedAt: string;
  updatedByProposalId?: string | null;
}

export enum IndexRebalanceTrigger {
  initial_buy = 'initial_buy',
  governance_reweight = 'governance_reweight',
}

export enum IndexRebalanceStatus {
  pending = 'pending',
  executing = 'executing',
  completed = 'completed',
  failed = 'failed',
}

export enum IndexLegStatus {
  pending = 'pending',
  confirmed = 'confirmed',
  failed = 'failed',
  skipped = 'skipped',
}

export enum IndexLegSide {
  sell = 'sell',
  buy = 'buy',
}

export interface IndexRebalanceLeg {
  index: number;
  side: IndexLegSide;
  operationId: string;
  /** address(0) = native. */
  assetIn: string;
  assetOut: string;
  amountIn: string;
  quotedOut?: string | null;
  minAmountOut?: string | null;
  /** Unix seconds; persisted before broadcast. Past it the vault rejects the leg's tx. */
  deadline?: string | null;
  grossOut?: string | null;
  fee?: string | null;
  txHash?: string | null;
  status: IndexLegStatus;
  error?: string | null;
}
