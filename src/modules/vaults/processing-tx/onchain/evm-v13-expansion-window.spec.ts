import { describe, expect, it } from '@jest/globals';

import { V13_MIN_EXPANSION_WINDOW_SEC, v13ExpansionEarliestClose } from './evm-v13';

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
