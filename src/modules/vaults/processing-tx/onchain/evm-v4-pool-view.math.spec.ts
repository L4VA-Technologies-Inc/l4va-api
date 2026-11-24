import { describe, expect, it } from '@jest/globals';

import { aggregateV4Positions } from './evm-v4-pool-view.math';
import type { V4Position } from './evm-v4-position-scanner.service';

import { sqrtPriceAtTick } from '@/modules/vaults/phase-management/governance/evm-lp-voting.math';

const VAULT = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';

// Live state of pool 0x257c…defb (vault 0x67b9…207b) on 2026-11-22: a full-range vault position
// and an ETH-only position above the price (tick 177627 < 177800).
const TICK = 177627;
const SQRT_P = sqrtPriceAtTick(TICK);
const vaultPos: V4Position = {
  tokenId: 4333184n,
  owner: VAULT,
  liquidity: 6950820147028858019n,
  tickLower: -887200,
  tickUpper: 887200,
};
const otherPos: V4Position = {
  tokenId: 4344367n,
  owner: OTHER,
  liquidity: 39171676393793264404n,
  tickLower: 177800,
  tickUpper: 184600,
};

const run = (positions: V4Position[]): ReturnType<typeof aggregateV4Positions> =>
  aggregateV4Positions({
    positions,
    sqrtPriceX96: SQRT_P,
    tick: TICK,
    vtIsCurrency0: false,
    isVault: o => o === VAULT,
  });

describe('aggregateV4Positions', () => {
  it('counts an out-of-range position in the pool total', () => {
    const t = run([vaultPos, otherPos]);
    expect(t.positions).toHaveLength(2);

    const other = t.positions.find(p => p.tokenId === 4344367n)!;
    expect(other.inRange).toBe(false);
    expect(other.vt).toBe(0n); // ETH-only: no VT inside, so no vote
    expect(other.native).toBeGreaterThan(0n);

    expect(t.totalNative).toBe(t.vaultNative + other.native);
    expect(t.totalVt).toBe(t.vaultVt);
  });

  it('shares are by value and sum to ~100%', () => {
    const t = run([vaultPos, otherPos]);
    const vault = t.positions.find(p => p.isVault)!;
    expect(t.vaultSharePct).toBe(vault.sharePct);
    expect(t.vaultSharePct!).toBeGreaterThan(0);
    expect(t.vaultSharePct!).toBeLessThan(100);
    const sum = t.positions.reduce((s, p) => s + (p.sharePct ?? 0), 0);
    expect(sum).toBeCloseTo(100, 1);
    expect(t.positions[0].isVault).toBe(true); // vault listed first
  });

  it('full-range only: vault owns 100%, VT side valued like the native side', () => {
    const t = run([vaultPos]);
    expect(t.vaultSharePct).toBe(100);
    const v = t.positions[0];
    // At the current price a full-range position holds equal value on both sides.
    const diff = Number(v.valueNative - 2n * v.native);
    expect(Math.abs(diff) / Number(v.valueNative)).toBeLessThan(1e-6);
  });

  it('skips burned/empty positions and handles an empty pool', () => {
    const t = run([{ ...otherPos, liquidity: 0n }]);
    expect(t.positions).toHaveLength(0);
    expect(t.vaultSharePct).toBeNull();
  });
});
