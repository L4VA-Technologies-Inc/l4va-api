/** Minimal ABIs for the fee → buyback pipeline (vault-contract-solidity). */

export const FEE_CONVERTER_ABI = [
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vaults', type: 'address[]' },
      { name: 'asset', type: 'address' },
    ],
    outputs: [{ name: 'total', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convert',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'adapter', type: 'address' },
      { name: 'minFeeTokenOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'route', type: 'bytes' },
    ],
    outputs: [{ name: 'feeTokenOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'depositFeeToken',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxConversionAmount',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'feeToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'KEEPER_ROLE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

export const FEE_CONTROLLER_ABI = [
  { type: 'function', name: 'totalReserve', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'feeToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const BUYBACK_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'executeAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'totalFeeIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'route', type: 'bytes' },
    ],
    outputs: [{ name: 'l4vaReceived', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxAmountPerExecution',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'referencePrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxSlippageBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'EXECUTOR_ROLE', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

export const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;
