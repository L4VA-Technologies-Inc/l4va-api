import { describe, expect, it } from '@jest/globals';
import { getAddress, keccak256, pad, toHex, type Address } from 'viem';

import { buildDistributionTree, hashDistributionLeaf } from './evm-distribution-merkle';

const addr = (n: number): Address => getAddress(pad(toHex(n), { size: 20 }));
const VAULT = addr(0xa1);
const KEY = keccak256(toHex('dist-vector'));
const E18 = 10n ** 18n;

// Same vectors as vault-contract-solidity test_matchesBackendTreeVectors.
describe('distribution Merkle tree', () => {
  const weights = new Map([
    [addr(0xd4), 2000n * E18],
    [addr(0xb2), 3000n * E18],
    [addr(0xc3), 3000n * E18],
  ]);

  it('matches the leaf encoding of VaultDistribution.leafHash', () => {
    expect(hashDistributionLeaf(VAULT, 4663n, KEY, addr(0xb2), 3000n * E18)).toBe(
      '0xe5b7dbf3a51c8c23c434ad5f885a369af7584982f2c976f7f3a8254d3599e4d4'
    );
  });

  it('produces the root and proofs pinned in the contract tests', () => {
    const tree = buildDistributionTree(VAULT, 4663n, KEY, weights);
    expect(tree.root).toBe('0x6600fda6dbfed6ceadb3b931ce31c7e4387f3f5afdb6ca98512bcb0d5e51d418');
    expect(tree.totalWeight).toBe(8000n * E18);
    expect(tree.entries.get(addr(0xc3).toLowerCase())?.proof).toEqual([
      '0x4e4377dfd6ad21bb6534420cfcc3d43722dd475340ac111ea636d697263dcbce',
      '0xe5b7dbf3a51c8c23c434ad5f885a369af7584982f2c976f7f3a8254d3599e4d4',
    ]);
  });

  it('drops zero weights and ignores input order', () => {
    const shuffled = new Map([...weights.entries()].reverse());
    shuffled.set(addr(0xee), 0n);
    const tree = buildDistributionTree(VAULT, 4663n, KEY, shuffled);
    expect(tree.root).toBe(buildDistributionTree(VAULT, 4663n, KEY, weights).root);
    expect(tree.entries.has(addr(0xee).toLowerCase())).toBe(false);
  });

  it('refuses an empty tree', () => {
    expect(() => buildDistributionTree(VAULT, 4663n, KEY, new Map([[addr(1), 0n]]))).toThrow();
  });
});
