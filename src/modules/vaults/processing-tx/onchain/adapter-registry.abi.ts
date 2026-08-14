// SPDX-License-Identifier: MIT — ABI for AdapterRegistry.sol
// Source of truth: vault-contract-solidity/src/AdapterRegistry.sol

import { keccak256, toHex } from 'viem';

export const ADAPTER_REGISTRY_ABI = [
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'approveAdapter',
    inputs: [
      { name: 'adapter', type: 'address' },
      { name: 'tag', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'revokeAdapter',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'approved',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'tags',
    inputs: [{ name: 'adapter', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'hasRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'AdapterApproved',
    inputs: [
      { name: 'adapter', type: 'address', indexed: true },
      { name: 'tag', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AdapterRevoked',
    inputs: [{ name: 'adapter', type: 'address', indexed: true }],
  },
] as const;

/** keccak256("ADAPTER_MANAGER_ROLE") — mirrors AdapterRegistry.ADAPTER_MANAGER_ROLE */
export const ADAPTER_MANAGER_ROLE = keccak256(toHex('ADAPTER_MANAGER_ROLE'));
