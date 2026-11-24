import type { Snapshot } from '@/database/snapshot.entity';

/**
 * Voting weight per address: directly held VT plus, on EVM, VT the address keeps in
 * Uniswap positions. Use this for votes and totals, never for payouts.
 */
export function votingBalances(snapshot: Pick<Snapshot, 'addressBalances' | 'lpBalances'>): Map<string, bigint> {
  const weights = new Map<string, bigint>();
  for (const source of [snapshot.addressBalances, snapshot.lpBalances]) {
    for (const [address, balance] of Object.entries(source ?? {})) {
      const key = address.toLowerCase();
      weights.set(key, (weights.get(key) ?? 0n) + BigInt(balance));
    }
  }
  return weights;
}

export function totalVotingPower(snapshot: Pick<Snapshot, 'addressBalances' | 'lpBalances'>): bigint {
  let total = 0n;
  for (const weight of votingBalances(snapshot).values()) total += weight;
  return total;
}
