/**
 * Minimal viem ABI slice for the V4 L4VA Vault (see `vault-contract-solidity/src/Vault.sol`).
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

export const TIME_WINDOW = [
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

// CycleView — MUST mirror the tuple returned by Vault.getCycle(uint256).
// Any drift here produces "Position N out of bounds" decode errors at runtime.
// Source of truth: vault-contract-solidity/src/Vault.sol#CycleView
const CYCLE_VIEW = [
  { name: 'status', type: 'uint8' as const },
  { name: 'assetWindow', type: 'tuple' as const, components: TIME_WINDOW },
  { name: 'acquireWindow', type: 'tuple' as const, components: TIME_WINDOW },
  { name: 'openedAt', type: 'uint64' as const },
  { name: 'nativeCollected', type: 'uint256' as const },
  { name: 'minAcquireThreshold', type: 'uint256' as const },
  { name: 'adaPairVtPerNativeUnit', type: 'uint256' as const },
  { name: 'allocationRoot', type: 'bytes32' as const },
  { name: 'valuationHash', type: 'bytes32' as const },
  { name: 'totalVtAllocation', type: 'uint256' as const },
  { name: 'totalNativeAllocation', type: 'uint256' as const },
  { name: 'claimedVt', type: 'uint256' as const },
  { name: 'claimedNative', type: 'uint256' as const },
];

// Contribution — MUST mirror the tuple returned by Vault.getContribution(uint256).
// Source of truth: vault-contract-solidity/src/libraries/VaultTypes.sol#Contribution
const CONTRIBUTION_VIEW = [
  { name: 'cycleId', type: 'uint256' as const },
  { name: 'contributor', type: 'address' as const },
  { name: 'kind', type: 'uint8' as const },
  { name: 'asset', type: 'address' as const },
  { name: 'tokenId', type: 'uint256' as const },
  { name: 'amount', type: 'uint256' as const },
  { name: 'status', type: 'uint8' as const },
  { name: 'authDigest', type: 'bytes32' as const },
  { name: 'authNonce', type: 'uint256' as const },
  { name: 'depositedAt', type: 'uint64' as const },
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
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'closeAssetWindow',
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
    name: 'totalContributions',
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

  // --- Authority (V4) -------------------------------------------------------
  {
    type: 'function',
    stateMutability: 'view',
    name: 'authority',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'pendingAuthority',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'proposeAuthority',
    inputs: [{ name: 'newAuthority', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'acceptAuthority',
    inputs: [],
    outputs: [],
  },

  // --- Fees (V4) ------------------------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'withdrawFees',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'accruedFeeNative',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  // --- Cycle open (Phase 1) -----------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'openCycle',
    inputs: [
      {
        name: 'cycle',
        type: 'tuple',
        components: [
          { name: 'assetWindow', type: 'tuple', components: TIME_WINDOW },
          { name: 'acquireWindow', type: 'tuple', components: TIME_WINDOW },
          { name: 'minAcquireThreshold', type: 'uint256' },
          { name: 'adaPairVtPerNativeUnit', type: 'uint256' },
          { name: 'assetWhitelist', type: 'address[]' },
          { name: 'contributorWhitelist', type: 'address[]' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },

  // --- Adapter positions (Phase 2) -----------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'openPosition',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'operationId', type: 'bytes32' },
          { name: 'adapter', type: 'address' },
          { name: 'protocol', type: 'address' },
          { name: 'inputAsset', type: 'address' },
          { name: 'maxInputAmount', type: 'uint256' },
          { name: 'expectedPositionAsset', type: 'address' },
          { name: 'minExpectedOutput', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'protocolParams', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'positionId', type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'closePosition',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'positionId', type: 'uint256' },
          { name: 'minUnderlyingReturned', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'protocolParams', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalPositions',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'activeExternalPositionCount',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  // --- Termination (Phase 4) -----------------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'beginTerminationPreparing',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'beginTermination',
    inputs: [{ name: 'distributableAssets', type: 'address[]' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'finalizeTermination',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'redeemForTermination',
    inputs: [{ name: 'vtAmount', type: 'uint256' }],
    outputs: [{ name: 'redemptionId', type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'claimTerminationNative',
    inputs: [{ name: 'redemptionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'claimTerminationAsset',
    inputs: [
      { name: 'redemptionId', type: 'uint256' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalRedemptions',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  // --- Emergency & pause (Phase 5) -----------------------------------------
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'pause',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'unpause',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'emergencyRecoverNative',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'emergencyRecoverERC20',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'accruedFeeErc20',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'paused',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'vaultToken',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    stateMutability: 'view',
    name: 'totalSupply',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  // --- Events (decoded from receipts + Alchemy webhooks) -------------------
  // NOTE: signatures MUST mirror IVault.sol exactly — any drift changes
  // topic0 and makes both `viem.getLogs({event})` and `decodeEventLog` fail
  // silently (returning zero results). See IVault.sol for the source of truth.
  {
    type: 'event',
    name: 'VaultInitialized',
    inputs: [
      { name: 'vaultId', type: 'bytes32', indexed: true },
      { name: 'authority', type: 'address', indexed: true },
      { name: 'mintingKey', type: 'address', indexed: false },
      { name: 'vaultToken', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AuthorityTransferProposed',
    inputs: [
      { name: 'current', type: 'address', indexed: true },
      { name: 'proposed', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AuthorityTransferred',
    inputs: [
      { name: 'previous', type: 'address', indexed: true },
      { name: 'next', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'FeeAccrued',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeeWithdrawn',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
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
      { name: 'authDigest', type: 'bytes32', indexed: false },
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
      { name: 'allocationRoot', type: 'bytes32', indexed: true },
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
      { name: 'previous', type: 'uint8', indexed: true },
      { name: 'next', type: 'uint8', indexed: true },
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
  {
    type: 'event',
    name: 'VaultStatusChanged',
    inputs: [
      { name: 'previous', type: 'uint8', indexed: true },
      { name: 'next', type: 'uint8', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'CycleOpened',
    inputs: [
      { name: 'cycleId', type: 'uint256', indexed: true },
      { name: 'assetWindowStart', type: 'uint64', indexed: false },
      { name: 'assetWindowEnd', type: 'uint64', indexed: false },
      { name: 'acquireWindowStart', type: 'uint64', indexed: false },
      { name: 'acquireWindowEnd', type: 'uint64', indexed: false },
      { name: 'adaPairVtPerNativeUnit', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PositionOpened',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'adapter', type: 'address', indexed: true },
      { name: 'underlyingAsset', type: 'address', indexed: true },
      { name: 'amountConsumed', type: 'uint256', indexed: false },
      { name: 'positionAsset', type: 'address', indexed: false },
      { name: 'positionAmount', type: 'uint256', indexed: false },
      { name: 'operationId', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PositionClosed',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'underlyingReturned', type: 'uint256', indexed: false },
      { name: 'status', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TerminationPrepared',
    inputs: [],
  },
  {
    type: 'event',
    name: 'TerminationSnapshotTaken',
    inputs: [
      { name: 'vtSupply', type: 'uint256', indexed: false },
      { name: 'nativeSnapshot', type: 'uint256', indexed: false },
      { name: 'distributableAssetsCount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RedemptionCreated',
    inputs: [
      { name: 'redemptionId', type: 'uint256', indexed: true },
      { name: 'holder', type: 'address', indexed: true },
      { name: 'vtBurned', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RedemptionNativeClaimed',
    inputs: [
      { name: 'redemptionId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RedemptionAssetClaimed',
    inputs: [
      { name: 'redemptionId', type: 'uint256', indexed: true },
      { name: 'asset', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EmergencyRecovered',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ProtocolFeeWithdrawn',
    inputs: [
      { name: 'asset', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;
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
