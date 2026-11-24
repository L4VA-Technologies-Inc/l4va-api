import type { Snapshot } from '@/database/snapshot.entity';

type SnapshotBalances = Pick<Snapshot, 'addressBalances' | 'lpBalances'>;

const isPositive = (balance: unknown): boolean => {
  try {
    return BigInt(String(balance)) > 0n;
  } catch {
    return parseFloat(String(balance)) > 0;
  }
};

/**
 * Everyone with a share in a snapshot: direct VT holders (`addressBalances`) plus, on EVM, owners
 * of Uniswap positions holding VT (`lpBalances`). This is the set distributions pay, votes weigh
 * and holder counts show, so every caller must go through here rather than read one map.
 *
 * Addresses are trimmed and lowercased (EVM addresses are case-insensitive; Cardano bech32 is
 * lowercase already), so an address in both maps counts once. Zero balances are dropped.
 */
export function snapshotRecipients(snapshot: SnapshotBalances | null | undefined): Set<string> {
  if (!snapshot) return new Set();
  return new Set(
    [...Object.entries(snapshot.addressBalances ?? {}), ...Object.entries(snapshot.lpBalances ?? {})]
      .filter(([address, balance]) => !!address?.trim() && isPositive(balance))
      .map(([address]) => address.trim().toLowerCase())
  );
}

/** Number of distinct addresses with a share in the snapshot. See {@link snapshotRecipients}. */
export function countSnapshotRecipients(snapshot: SnapshotBalances | null | undefined): number {
  return snapshotRecipients(snapshot).size;
}
