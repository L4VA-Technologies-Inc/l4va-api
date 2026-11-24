import { Brackets } from 'typeorm';

/**
 * The single definition of "this user is part of this vault". Used by My Vaults search,
 * profile stats (total_vaults) and login counts so they can never disagree.
 *
 * A user is part of a vault when they:
 *  - own it, or
 *  - contributed an asset that is now locked or distributed, or
 *  - appear in any of its snapshots as a VT holder (`address_balances`) or LP position
 *    holder (`lp_balances`).
 *
 * EVM snapshots store addresses lowercased and Cardano ones as-is, so both forms are checked.
 * The query alias for the vault table must be `vault`.
 */
export function userVaultMembership(userId: string, userAddress: string | null | undefined): Brackets {
  const address = userAddress ?? '';
  return new Brackets(qb => {
    qb.where('vault.owner_id = :uvmUserId', { uvmUserId: userId })
      .orWhere(
        `EXISTS (
          SELECT 1 FROM assets
          WHERE assets.vault_id = vault.id
            AND assets.added_by = :uvmUserId
            AND assets.status IN ('locked', 'distributed')
        )`
      )
      .orWhere(
        `EXISTS (
          SELECT 1 FROM snapshot
          WHERE snapshot.vault_id = vault.id
            AND (snapshot.address_balances -> :uvmAddress IS NOT NULL
              OR snapshot.address_balances -> :uvmAddressLower IS NOT NULL
              OR snapshot.lp_balances -> :uvmAddressLower IS NOT NULL)
        )`,
        { uvmAddress: address, uvmAddressLower: address.toLowerCase() }
      );
  });
}

/** Same rule for a snapshot row already loaded in memory. */
export function snapshotHasUser(
  snapshot: { address_balances?: Record<string, unknown> | null; lp_balances?: Record<string, unknown> | null },
  userAddress: string | null | undefined
): boolean {
  if (!userAddress) return false;
  const lower = userAddress.toLowerCase();
  return Boolean(
    snapshot.address_balances?.[userAddress] ?? snapshot.address_balances?.[lower] ?? snapshot.lp_balances?.[lower]
  );
}
