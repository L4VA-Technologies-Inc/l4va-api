import { describe, expect, it } from '@jest/globals';

import { ProposalType } from '../../types/proposal.types';
import { TransactionType } from '../../types/transaction.types';

import { getExpansionWindows } from './expansion-activity';

const d = (day: number): Date => new Date(Date.UTC(2026, 5, day));
const tx = (id: string, type: TransactionType, at: Date, metadata = {}) => ({
  id,
  type,
  created_at: at,
  metadata,
  tx_hash: `0x${id}`,
});

describe('getExpansionWindows', () => {
  it('numbers per type and closes each window at the first close tx inside it', () => {
    const windows = getExpansionWindows(
      [
        { id: 'a', proposalType: ProposalType.EXPANSION, executionDate: d(10), metadata: {} },
        { id: 'b', proposalType: ProposalType.ACQUIRE_EXPANSION, executionDate: d(20), metadata: {} },
        { id: 'c', proposalType: ProposalType.EXPANSION, executionDate: d(30), metadata: {} },
      ],
      // d(5): before any window (initial lock); d(12) closes a; d(25) closes b; c still open.
      [
        tx('t1', TransactionType.updateVault, d(5)),
        tx('t2', TransactionType.updateVault, d(12)),
        tx('t3', TransactionType.updateVault, d(25)),
      ]
    );

    expect(windows.map(w => [w.proposalType, w.number, w.startedAt, w.closedAt])).toEqual([
      [ProposalType.EXPANSION, 1, d(10), d(12)],
      [ProposalType.ACQUIRE_EXPANSION, 1, d(20), d(25)],
      [ProposalType.EXPANSION, 2, d(30), null],
    ]);
  });

  it('marks a cancelled EVM cycle and ignores openCycle txs as closes', () => {
    const windows = getExpansionWindows(
      [
        { id: 'a', proposalType: ProposalType.ACQUIRE_EXPANSION, executionDate: d(10), metadata: {} },
        { id: 'b', proposalType: ProposalType.ACQUIRE_EXPANSION, executionDate: d(20), metadata: {} },
      ],
      [
        tx('c1', TransactionType.evmCloseCycle, d(5)),
        // openCycle lands just before the proposal is marked executed.
        tx('o2', TransactionType.evmOpenCycle, d(10)),
        tx('x2', TransactionType.evmCancelCycle, d(11), { message: 'Nothing was acquired' }),
        tx('o3', TransactionType.evmOpenCycle, d(20)),
        tx('c3', TransactionType.evmCloseCycle, d(21)),
      ]
    );

    expect(windows.map(w => [w.cancelled, w.closeTx?.id, w.nextStartedAt])).toEqual([
      [true, 'x2', d(20)],
      [false, 'c3', null],
    ]);
  });

  it('prefers the recorded close over close txs', () => {
    const [w] = getExpansionWindows(
      [
        {
          id: 'a',
          proposalType: ProposalType.EXPANSION,
          executionDate: d(10),
          metadata: { expansionClose: { closedAt: d(14).toISOString(), reason: 'asset_max_reached' } },
        },
      ],
      [tx('t', TransactionType.updateVault, d(11))]
    );

    expect([w.closedAt, w.reason, w.cancelled]).toEqual([d(14), 'asset_max_reached', false]);
  });
});
