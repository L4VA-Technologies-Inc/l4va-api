import type { Address } from 'viem';

export interface VtReleasePlan {
  recipients: Address[];
  amounts: bigint[];
  /** Sum of `amounts`; always equals the released amount. */
  total: bigint;
}

/**
 * Split the VT that came out of a vault's LP position across its holders, pro rata to their
 * current balances. Handing `L` VT to holders of `S − L` this way gives every holder the same
 * redemption share they would have if the `L` VT had been burned.
 *
 * Holders in `excluded` (the exit adapter, the PoolManager, the vault, VaultToken-excluded
 * addresses) get nothing. Floor rounding leaves at most `n − 1` base units; they go to the
 * largest holder so the whole amount is released and nothing stays earmarked.
 */
export function computeVtRelease(
  lpVt: bigint,
  balances: Map<string, bigint>,
  excluded: Iterable<string>
): VtReleasePlan {
  const skip = new Set([...excluded].map(a => a.toLowerCase()));
  const holders = [...balances.entries()]
    .map(([addr, bal]) => [addr.toLowerCase(), bal] as const)
    .filter(([addr, bal]) => bal > 0n && !skip.has(addr))
    // Deterministic order: largest first, then address — the remainder goes to index 0.
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));

  if (lpVt === 0n) return { recipients: [], amounts: [], total: 0n };
  if (holders.length === 0) throw new Error('No eligible VT holders to receive the pool VT');

  const held = holders.reduce((s, [, b]) => s + b, 0n);
  const amounts = holders.map(([, b]) => (lpVt * b) / held);
  const assigned = amounts.reduce((s, a) => s + a, 0n);
  amounts[0] += lpVt - assigned;

  const recipients: Address[] = [];
  const out: bigint[] = [];
  holders.forEach(([addr], i) => {
    if (amounts[i] > 0n) {
      recipients.push(addr as Address);
      out.push(amounts[i]);
    }
  });
  return { recipients, amounts: out, total: lpVt };
}

/** Split parallel arrays into chunks of at most `size` (one `releaseToken` call each). */
export function chunkRelease(plan: VtReleasePlan, size: number): Array<{ recipients: Address[]; amounts: bigint[] }> {
  const chunks: Array<{ recipients: Address[]; amounts: bigint[] }> = [];
  for (let i = 0; i < plan.recipients.length; i += size) {
    chunks.push({ recipients: plan.recipients.slice(i, i + size), amounts: plan.amounts.slice(i, i + size) });
  }
  return chunks;
}
