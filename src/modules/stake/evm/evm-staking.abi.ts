/**
 * L4VAStaking (vault-contract-solidity/src/L4VAStaking.sol) — the subset the
 * API reads. Writes (stake / unstake / harvest / compound) are sent by the
 * user's wallet straight from the client.
 */
export const EVM_STAKING_ABI = [
  { name: 'MAX_BATCH', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'stakeFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'feeRecipient', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    name: 'listedTokens',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  {
    name: 'tokenConfig',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'listed', type: 'bool' },
          { name: 'enabled', type: 'bool' },
          { name: 'apyBps', type: 'uint16' },
          { name: 'lastUpdate', type: 'uint64' },
          { name: 'minStake', type: 'uint256' },
          { name: 'rewardIndex', type: 'uint256' },
          { name: 'totalStaked', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'rewardReserve',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'positionsOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    name: 'getPosition',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'stakedAt', type: 'uint64' },
          { name: 'open', type: 'bool' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'indexAtStake', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'pendingReward',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'positionId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'Staked',
    type: 'event',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Unstaked',
    type: 'event',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'principal', type: 'uint256', indexed: false },
      { name: 'reward', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Harvested',
    type: 'event',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'reward', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'Compounded',
    type: 'event',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'reward', type: 'uint256', indexed: false },
      { name: 'newAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'EmergencyUnstaked',
    type: 'event',
    inputs: [
      { name: 'positionId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'principal', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const ERC20_METADATA_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;
