export enum TransactionStatus {
  created = 'created',
  pending = 'pending',
  submitted = 'submitted',
  confirmed = 'confirmed',
  failed = 'failed',
  stuck = 'stuck',
  /** Contribution was refunded on-chain (either via self-cancel or after cycle cancel). */
  refunded = 'refunded',
}

export enum TransactionType {
  createVault = 'create-vault',
  mint = 'mint',
  payment = 'payment',
  contribute = 'contribute', // Contains NFTs
  claim = 'claim',
  extract = 'extract',
  extractDispatch = 'extract-dispatch',
  cancel = 'cancel',
  /** Contains only lovelace (ADA) */
  acquire = 'acquire',
  investment = 'investment',
  burn = 'burn',
  swap = 'swap',
  stake = 'stake',
  unstake = 'unstake',
  harvest = 'harvest',
  compound = 'compound',
  extractLp = 'extract-lp',
  distributeLp = 'distribute-lp',
  /** ADA distribution from treasury to VT holders */
  distribution = 'distribution',
  /** Vault metadata update transaction */
  updateVault = 'update-vault',
  /** WayUp marketplace transaction (listing, unlisting, update, offer, purchase) */
  wayup = 'wayup',
  /** EVM: admin-signed `closeCycle(root, hash, totalVt, totalNative)`. */
  evmCloseCycle = 'evm-close-cycle',
  /** EVM: admin-signed `claimAllocations([...])` batch airdrop. */
  evmClaim = 'evm-claim',
  /** EVM: admin-signed `refundContributions([...])` batch refund. */
  evmRefund = 'evm-refund',
  /** EVM: admin-signed `cancelCurrentCycle()`. */
  evmCancelCycle = 'evm-cancel-cycle',
  all = 'all',
}

/**
 * Status of the domain-event reconciliation for a confirmed EVM transaction.
 * The webhook path is the fast path; the transaction-health checker is the
 * durable retry path. A tx is only "fully processed" when this reaches
 * `success`.
 *
 *   pending                 — awaiting first reconciliation or retrying after error.
 *   success                 — every expected event was decoded and applied. reconciled_at set.
 *   failed                  — terminal: reverted receipt or unrecoverable error.
 *   manual_review_required  — retry cap hit while still pending. Explicit `retry`
 *                             endpoint can reset it back to `pending`.
 */
export enum EvmReconciliationStatus {
  pending = 'pending',
  success = 'success',
  failed = 'failed',
  manual_review_required = 'manual_review_required',
}

/**
 * Shape of a single entry in `transactions.expected_events`. Callers that
 * broadcast admin transactions must attach a spec so the reconciler knows
 * what must be present in the receipt for the tx to count as successful.
 *   name  — one of the VAULT_ABI event names
 *   count — required occurrences of that event (default 1)
 */
export interface ExpectedEventSpec {
  name: string;
  count?: number;
}
