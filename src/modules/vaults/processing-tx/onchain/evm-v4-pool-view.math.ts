import { amountsForLiquidity, sqrtPriceAtTick } from '../../phase-management/governance/evm-lp-voting.math';

import type { V4Position } from './evm-v4-position-scanner.service';

export interface V4PositionAmounts {
  tokenId: bigint;
  owner: string;
  isVault: boolean;
  inRange: boolean;
  tickLower: number;
  tickUpper: number;
  /** Raw token amounts held by the position at the current price. */
  vt: bigint;
  native: bigint;
  /** Both sides valued in native wei at the pool price. */
  valueNative: bigint;
  /** Share of the whole pool's value, 0..100 (null when the pool is empty). */
  sharePct: number | null;
}

export interface V4PoolTotals {
  positions: V4PositionAmounts[];
  totalVt: bigint;
  totalNative: bigint;
  totalValueNative: bigint;
  vaultVt: bigint;
  vaultNative: bigint;
  vaultValueNative: bigint;
  vaultSharePct: number | null;
}

const Q192 = 2n ** 192n;

const pct = (part: bigint, total: bigint): number | null =>
  total > 0n ? Number((part * 1_000_000n) / total) / 10_000 : null;

/**
 * Every position's token amounts at the current price (any tick range), pool totals as their sum,
 * and shares by VALUE. Liquidity units of positions with different ranges are not comparable, so a
 * share by liquidity would be wrong as soon as one LP is not full range.
 */
export function aggregateV4Positions(params: {
  positions: V4Position[];
  sqrtPriceX96: bigint;
  tick: number;
  vtIsCurrency0: boolean;
  isVault: (owner: string) => boolean;
}): V4PoolTotals {
  const { sqrtPriceX96: sqrtP, tick, vtIsCurrency0, isVault } = params;
  // price = currency1 per currency0 = sqrtP² / 2^192
  const vtToNative = (vt: bigint): bigint =>
    sqrtP === 0n ? 0n : vtIsCurrency0 ? (vt * sqrtP * sqrtP) / Q192 : (vt * Q192) / (sqrtP * sqrtP);

  const rows = params.positions
    .filter(p => p.liquidity > 0n)
    .map(p => {
      const { amount0, amount1 } =
        sqrtP === 0n
          ? { amount0: 0n, amount1: 0n }
          : amountsForLiquidity(p.liquidity, sqrtP, sqrtPriceAtTick(p.tickLower), sqrtPriceAtTick(p.tickUpper));
      const [vt, native] = vtIsCurrency0 ? [amount0, amount1] : [amount1, amount0];
      return {
        tokenId: p.tokenId,
        owner: p.owner.toLowerCase(),
        isVault: isVault(p.owner.toLowerCase()),
        inRange: tick >= p.tickLower && tick < p.tickUpper,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        vt,
        native,
        valueNative: native + vtToNative(vt),
        sharePct: null as number | null,
      };
    });

  const sum = (xs: V4PositionAmounts[], f: (r: V4PositionAmounts) => bigint): bigint =>
    xs.reduce((s, r) => s + f(r), 0n);
  const totalValueNative = sum(rows, r => r.valueNative);
  for (const r of rows) r.sharePct = pct(r.valueNative, totalValueNative);
  rows.sort((a, b) => Number(b.isVault) - Number(a.isVault) || (b.valueNative > a.valueNative ? 1 : -1));

  const vaultRows = rows.filter(r => r.isVault);
  const vaultValueNative = sum(vaultRows, r => r.valueNative);
  return {
    positions: rows,
    totalVt: sum(rows, r => r.vt),
    totalNative: sum(rows, r => r.native),
    totalValueNative,
    vaultVt: sum(vaultRows, r => r.vt),
    vaultNative: sum(vaultRows, r => r.native),
    vaultValueNative,
    vaultSharePct: pct(vaultValueNative, totalValueNative),
  };
}
