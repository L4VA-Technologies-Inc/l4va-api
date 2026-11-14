import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

/**
 * Merkle leaf helper for V3 allocation trees.
 *
 * The Solidity contract computes:
 *   leaf = keccak256(abi.encode(
 *     address vault,
 *     uint256 chainId,
 *     uint256 cycleId,
 *     uint256 claimIndex,
 *     address contributor,
 *     uint256 vtAmount,
 *     uint256 nativeAmount
 *   ))
 * and verifies proofs using OpenZeppelin `MerkleProof.verifyCalldata`
 * (sorted-pair inner hashing, single-hashed leaves).
 *
 * We use OZ's `SimpleMerkleTree` (NOT `StandardMerkleTree`, which
 * double-hashes) so our TypeScript-built root matches what the contract
 * derives from a submitted claim.
 *
 * See:
 *  - vault-contract-solidity/src/libraries/VaultAllocation.sol#leafHash
 *  - openzeppelin/merkle-tree docs: "Leaf hashing" section
 */

/** Fields that go into the on-chain Merkle leaf. */
export interface AllocationLeafInput {
  vault: Address;
  chainId: bigint;
  cycleId: bigint;
  claimIndex: bigint;
  contributor: Address;
  vtAmount: bigint;
  nativeAmount: bigint;
}

const LEAF_ABI = [
  { name: 'vault', type: 'address' as const },
  { name: 'chainId', type: 'uint256' as const },
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'claimIndex', type: 'uint256' as const },
  { name: 'contributor', type: 'address' as const },
  { name: 'vtAmount', type: 'uint256' as const },
  { name: 'nativeAmount', type: 'uint256' as const },
];

/** Compute the on-chain leaf hash for a single allocation input. */
export function hashAllocationLeaf(input: AllocationLeafInput): Hex {
  const encoded = encodeAbiParameters(LEAF_ABI, [
    input.vault,
    input.chainId,
    input.cycleId,
    input.claimIndex,
    input.contributor,
    input.vtAmount,
    input.nativeAmount,
  ]);
  return keccak256(encoded);
}

export interface AllocationMerkleTreeBuildResult {
  root: Hex;
  /** Same order as input; index into proofs matches the input's `claimIndex`. */
  proofs: Hex[][];
  leafHashes: Hex[];
}

/**
 * Build the Merkle tree from a set of leaf inputs.
 *
 * IMPORTANT: The `claimIndex` on every leaf MUST equal the leaf's index in
 * this input array. That index is the on-chain dedup key stored in the
 * contract's `_claimedBitMap[cycleId]`.
 *
 * The returned `proofs[i]` is the proof for `leafHashes[i]` — which is the
 * same as the proof for `inputs[i]`.
 */
export function buildAllocationMerkleTree(inputs: AllocationLeafInput[]): AllocationMerkleTreeBuildResult {
  if (inputs.length === 0) {
    throw new Error('Cannot build a Merkle tree with zero leaves');
  }
  const leafHashes: Hex[] = inputs.map((input, i) => {
    if (input.claimIndex !== BigInt(i)) {
      throw new Error(`Leaf at position ${i} has claimIndex=${input.claimIndex}; must equal its position.`);
    }
    return hashAllocationLeaf(input);
  });

  const tree = SimpleMerkleTree.of(leafHashes);
  const proofs = leafHashes.map((_, i) => tree.getProof(i) as Hex[]);

  return {
    root: tree.root as Hex,
    proofs,
    leafHashes,
  };
}
