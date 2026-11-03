import type { Proposal } from '../../database/proposal.entity';
import type { Transaction } from '../../database/transaction.entity';
import { ProposalType } from '../../types/proposal.types';
import { TransactionType } from '../../types/transaction.types';

export type BoundaryTx = Pick<Transaction, 'id' | 'type' | 'created_at' | 'metadata' | 'tx_hash'>;

export interface ExpansionWindow {
  proposalId: string;
  proposalType: ProposalType;
  /** 1-based, counted per expansion type. */
  number: number;
  /** Proposal execution: the window opens on execution. */
  startedAt: Date;
  closedAt: Date | null;
  /** Tx that closed the window, when found (EVM close / cancel, Cardano metadata update). */
  closeTx: BoundaryTx | null;
  cancelled: boolean;
  /** Next window's start: refunds of a cancelled window land before it. */
  nextStartedAt: Date | null;
  /** EVM only: the on-chain cycle the window ran as; resolved by the caller from snapshots / contributions. */
  cycleId: string | null;
  reason: string | null;
}

const CLOSE_TYPES: string[] = [
  TransactionType.updateVault,
  TransactionType.evmCloseCycle,
  TransactionType.evmCancelCycle,
];

/**
 * One window per executed expansion proposal. It closes at the stored
 * `expansionClose`, or, for proposals closed before that was recorded, at the
 * first close tx after execution and before the next window.
 */
export function getExpansionWindows(
  proposals: Pick<Proposal, 'id' | 'proposalType' | 'executionDate' | 'metadata'>[],
  boundaryTxs: BoundaryTx[]
): ExpansionWindow[] {
  const executed = proposals
    .filter(p => p.executionDate)
    .sort((a, b) => new Date(a.executionDate).getTime() - new Date(b.executionDate).getTime());
  const closeTxs = boundaryTxs.filter(tx => CLOSE_TYPES.includes(tx.type));
  const counts = new Map<ProposalType, number>();

  return executed.map((p, i) => {
    const number = (counts.get(p.proposalType) ?? 0) + 1;
    counts.set(p.proposalType, number);

    const startedAt = new Date(p.executionDate);
    const nextStartedAt = executed[i + 1] ? new Date(executed[i + 1].executionDate) : null;
    const inWindow = (tx: BoundaryTx): boolean => {
      const t = new Date(tx.created_at).getTime();
      return t > startedAt.getTime() && t < (nextStartedAt?.getTime() ?? Infinity);
    };
    const stored = p.metadata?.expansionClose;
    const closeTx = closeTxs.find(inWindow) ?? null;

    return {
      proposalId: p.id,
      proposalType: p.proposalType,
      number,
      startedAt,
      closedAt: stored?.closedAt ? new Date(stored.closedAt) : closeTx ? new Date(closeTx.created_at) : null,
      closeTx,
      cancelled: !stored && closeTx?.type === TransactionType.evmCancelCycle,
      nextStartedAt,
      cycleId: null,
      reason: stored?.reason ?? null,
    };
  });
}
