import { keccak256, toBytes } from 'viem';

/**
 * Nonce of the contribution authorization signed for asset `index` of transaction `txId`.
 * Deterministic so retries collapse on-chain to the same slot, and so a contribution
 * submitted outside our confirm flow can be traced back to its Transaction row.
 */
export const deriveContributionNonce = (txId: string, index: number): bigint =>
  BigInt(keccak256(toBytes(`${txId}:${index}`)));
