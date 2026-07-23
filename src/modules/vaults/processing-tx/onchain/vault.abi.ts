/**
 * Minimal viem ABI slice for the V3 L4VA Vault (see `vault-contract-solidity/src/Vault.sol`).
 * Only entries the backend actually needs:
 *   - read views for state verification pre-broadcast
 *   - write functions the admin key signs (close/cancel/claim batch/refund batch)
 *   - contribute* writes (used by evm-vault-contribution.service)
 *   - events decoded from tx receipts and Alchemy webhooks
 *
 * Keep in lock-step with the Solidity contract. Regenerate leaves and add missing
 * entries here if the contract surface changes.
 */

// -----------------------------------------------------------------------------
// Struct components — matched by name/order to VaultTypes.sol.
// -----------------------------------------------------------------------------

const TIME_WINDOW = [
  { name: 'start', type: 'uint64' as const },
  { name: 'end', type: 'uint64' as const },
];

const CONTRIBUTION_AUTHORIZATION = [
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'contributor', type: 'address' as const },
  { name: 'kind', type: 'uint8' as const },
  { name: 'asset', type: 'address' as const },
  { name: 'tokenId', type: 'uint256' as const },
  { name: 'amount', type: 'uint256' as const },
  { name: 'nonce', type: 'uint256' as const },
  { name: 'deadline', type: 'uint256' as const },
];

const ALLOCATION_CLAIM = [
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'claimIndex', type: 'uint256' as const },
  { name: 'contributor', type: 'address' as const },
  { name: 'vtAmount', type: 'uint256' as const },
  { name: 'nativeAmount', type: 'uint256' as const },
  { name: 'proof', type: 'bytes32[]' as const },
];

const CYCLE_VIEW = [
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'status', type: 'uint8' as const },
  { name: 'assetWindow', type: 'tuple' as const, components: TIME_WINDOW },
  { name: 'acquireWindow', type: 'tuple' as const, components: TIME_WINDOW },
  { name: 'minAcquireThreshold', type: 'uint256' as const },
  { name: 'adaPairVtPerNativeUnit', type: 'uint256' as const },
  { name: 'allocationRoot', type: 'bytes32' as const },
  { name: 'valuationHash', type: 'bytes32' as const },
  { name: 'totalVtAllocation', type: 'uint256' as const },
  { name: 'claimedVt', type: 'uint256' as const },
  { name: 'totalNativeAllocation', type: 'uint256' as const },
  { name: 'claimedNative', type: 'uint256' as const },
  { name: 'nativeCollected', type: 'uint256' as const },
];

const CONTRIBUTION_VIEW = [
  { name: 'id', type: 'uint256' as const },
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'contributor', type: 'address' as const },
  { name: 'kind', type: 'uint8' as const },
  { name: 'asset', type: 'address' as const },
  { name: 'tokenId', type: 'uint256' as const },
  { name: 'amount', type: 'uint256' as const },
  { name: 'status', type: 'uint8' as const },
];

// -----------------------------------------------------------------------------
// ABI
// -----------------------------------------------------------------------------

export const VAULT_ABI = [
  // --- Contributions -------------------------------------------------------
  {
    type: 'function',
    stateMutability: 'payable',
    name: 'contributeNative',
    inputs: [
      { name: 'auth', type: 'tuple', components: CONTRIBUTION_AUTHORIZATION },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'contributeERC20',
    inputs: [
      { name: 'auth', type: 'tuple', components: CONTRIBUTION_AUTHORIZATION },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'contributeERC721',
    inputs: [
      { name: 'auth', type: 'tuple', components: CONTRIBUTION_AUTHORIZATION },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'contributeERC1155',
    inputs: [
      { name: 'auth', type: 'tuple', components: CONTRIBUTION_AUTHORIZATION },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },

  // --- Refunds / cancels ---------------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'cancelContribution',
    inputs: [{ name: 'contributionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'refundContribution',
    inputs: [{ name: 'contributionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'refundContributions',
    inputs: [{ name: 'contributionIds', type: 'uint256[]' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'cancelCurrentCycle',
    inputs: [],
    outputs: [],
  },

  // --- Cycle lifecycle -----------------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'closeCycle',
    inputs: [
      { name: 'allocationRoot', type: 'bytes32' },
      { name: 'valuationHash', type: 'bytes32' },
      { name: 'totalVtAllocation', type: 'uint256' },
      { name: 'totalNativeAllocation', type: 'uint256' },
    ],
    outputs: [],
  },

  // --- Claims --------------------------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'claimAllocation',
    inputs: [
      { name: 'cycleId', type: 'uint256' },
      { name: 'claimIndex', type: 'uint256' },
      { name: 'contributor', type: 'address' },
      { name: 'vtAmount', type: 'uint256' },
      { name: 'nativeAmount', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'claimAllocations',
    inputs: [{ name: 'claims', type: 'tuple[]', components: ALLOCATION_CLAIM }],
    outputs: [],
  },

  // --- View helpers --------------------------------------------------------
  {
    type: 'function',
    stateMutability: 'view',
    name: 'isClaimed',
    inputs: [
      { name: 'cycleId', type: 'uint256' },
      { name: 'claimIndex', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getContribution',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: CONTRIBUTION_VIEW }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'getCycle',
    inputs: [{ name: 'cycleId', type: 'uint256' }],
    outputs: [{ type: 'tuple', components: CYCLE_VIEW }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'currentCycleId',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'status',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalOutstandingClaimVt',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalOutstandingClaimNative',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalOutstandingAcquireRefund',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  // --- Events (decoded from receipts + Alchemy webhooks) -------------------
  {
    type: 'event',
    name: 'ContributionMade',
    inputs: [
      { name: 'contributionId', type: 'uint256', indexed: true },
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'contributor', type: 'address', indexed: true },
      { name: 'kind', type: 'uint8', indexed: false },
      { name: 'asset', type: 'address', indexed: false },
      { name: 'tokenId', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ContributionCancelled',
    inputs: [
      { name: 'contributionId', type: 'uint256', indexed: true },
      { name: 'contributor', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'CycleClosed',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'allocationRoot', type: 'bytes32', indexed: false },
      { name: 'valuationHash', type: 'bytes32', indexed: false },
      { name: 'totalVtAllocation', type: 'uint256', indexed: false },
      { name: 'totalNativeAllocation', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CycleStatusChanged',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'newStatus', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AllocationClaimed',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'claimIndex', type: 'uint256', indexed: true },
      { name: 'contributor', type: 'address', indexed: true },
      { name: 'vtAmount', type: 'uint256', indexed: false },
      { name: 'nativeAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Mirror of `VaultTypes.sol#CycleStatus`. */
export enum EvmCycleStatus {
  Active = 0,
  Locked = 1,
  Cancelled = 2,
}

/** Mirror of `VaultTypes.sol#VaultStatus`. */
export enum EvmVaultOnchainStatus {
  Pending = 0,
  Active = 1,
  Locked = 2,
  Cancelled = 3,
  TerminationPreparing = 4,
  Terminating = 5,
  Terminated = 6,
}

/** Mirror of `VaultTypes.sol#Contribution.status`. */
export enum EvmContributionStatus {
  Active = 0,
  Cancelled = 1,
}

/** Mirror of `VaultTypes.sol#AssetKind` (already used in evm-vault-contribution.service.ts as EvmAssetKind). */
export enum EvmAssetKindOnchain {
  Native = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
}
