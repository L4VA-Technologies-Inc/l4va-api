import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/**
 * Merkle tree for weighted EVM distributions.
 *
 * The vault computes
 *   leaf = keccak256(abi.encode(address vault, uint256 chainId, bytes32 executionKey, address holder, uint256 weight))
 * and pays `weight * netPot / totalWeight` (vault-contract-solidity
 * src/libraries/VaultDistribution.sol). Weights are voting weights from the
 * proposal's snapshot (held VT + VT in liquidity positions), so holders who
 * keep VT in a pool are paid for it as on Cardano. The tree is deterministic
 * for a snapshot, so the claim bot rebuilds it instead of storing proofs.
 *
 * Same rules as `evm-allocation-merkle.ts`: `SimpleMerkleTree` over
 * pre-hashed leaves, never `StandardMerkleTree` (which double-hashes).
 */

const LEAF_ABI = [
  { name: 'vault', type: 'address' as const },
  { name: 'chainId', type: 'uint256' as const },
  { name: 'executionKey', type: 'bytes32' as const },
  { name: 'holder', type: 'address' as const },
  { name: 'weight', type: 'uint256' as const },
];

export interface DistributionTreeEntry {
  weight: bigint;
  proof: Hex[];
}

export interface DistributionTree {
  root: Hex;
  totalWeight: bigint;
  /** Keyed by lowercase holder address. */
  entries: Map<string, DistributionTreeEntry>;
}

export function hashDistributionLeaf(
  vault: Address,
  chainId: bigint,
  executionKey: Hex,
  holder: Address,
  weight: bigint
): Hex {
  return keccak256(encodeAbiParameters(LEAF_ABI, [vault, chainId, executionKey, holder, weight]));
}

/** Holders with zero weight are left out; the order of `weights` does not matter. */
export function buildDistributionTree(
  vault: Address,
  chainId: bigint,
  executionKey: Hex,
  weights: Map<string, bigint>
): DistributionTree {
  const holders = [...weights.entries()]
    .filter(([, weight]) => weight > 0n)
    .map(([address, weight]) => [address.toLowerCase(), weight] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (holders.length === 0) throw new Error('Cannot build a distribution tree with no weighted holders');

  const leaves = holders.map(([holder, weight]) =>
    hashDistributionLeaf(vault, chainId, executionKey, holder as Address, weight)
  );
  const tree = SimpleMerkleTree.of(leaves);

  const entries = new Map<string, DistributionTreeEntry>();
  let totalWeight = 0n;
  holders.forEach(([holder, weight], i) => {
    entries.set(holder, { weight, proof: tree.getProof(i) as Hex[] });
    totalWeight += weight;
  });
  return { root: tree.root as Hex, totalWeight, entries };
}
