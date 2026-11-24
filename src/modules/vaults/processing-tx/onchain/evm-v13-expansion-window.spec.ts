import { describe, expect, it } from '@jest/globals';

import { acquireExpansionVtForWei, V13_MIN_EXPANSION_WINDOW_SEC, v13ExpansionEarliestClose } from './evm-v13';

describe('v13ExpansionEarliestClose', () => {
  const openedAt = 1_795_885_360n; // 2026-11-23 17:02:40 UTC

  it('is openedAt + 24h for a V13 expansion cycle', () => {
    expect(v13ExpansionEarliestClose({ evm_protocol_version: 15 }, true, openedAt)).toBe(
      openedAt + V13_MIN_EXPANSION_WINDOW_SEC
    );
  });

  it('does not apply to the first (raise) cycle', () => {
    expect(v13ExpansionEarliestClose({ evm_protocol_version: 15 }, false, openedAt)).toBeNull();
  });

  it('does not apply before V13', () => {
    expect(v13ExpansionEarliestClose({ evm_protocol_version: 12 }, true, openedAt)).toBeNull();
    expect(v13ExpansionEarliestClose({ evm_protocol_version: null }, true, openedAt)).toBeNull();
  });

  it('does not apply without an on-chain open time', () => {
    expect(v13ExpansionEarliestClose({ evm_protocol_version: 15 }, true, 0n)).toBeNull();
  });
});

describe('acquireExpansionVtForWei', () => {
  it('matches the stage snapshot root for 0.04558 ETH at 1755.1 VT/ETH', () => {
    // Snapshot 033472ac: limitPrice=1755.1, totalVt=79998435873919047818 (two contributions).
    const vt = acquireExpansionVtForWei(45_580_557_161_369_180n, 1755.1, 18);
    // Per-contribution rounding in the snapshot can differ by a few base units from the sum.
    expect(vt - 79_998_435_873_919_047_818n).toBeLessThanOrEqual(2n);
    expect(79_998_435_873_919_047_818n - vt).toBeLessThanOrEqual(2n);
  });

  it('is 0 for 0 wei', () => {
    expect(acquireExpansionVtForWei(0n, 1755.1, 18)).toBe(0n);
  });
});
