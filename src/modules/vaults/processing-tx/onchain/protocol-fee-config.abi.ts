/** Mirrors `FeeType` in vault-contract-solidity/src/interfaces/IProtocolFeeConfig.sol. */
export enum ProtocolFeeType {
  Contribution = 0,
  Distribution = 1,
  Trade = 2,
}

/** The parts of `ProtocolFeeConfig` the API reads and, as FEE_MANAGER, writes. */
export const PROTOCOL_FEE_CONFIG_ABI = [
  {
    type: 'function',
    stateMutability: 'view',
    name: 'feeBps',
    inputs: [{ name: 'feeType', type: 'uint8' }],
    outputs: [{ type: 'uint16' }],
  },
  {
    type: 'function',
    stateMutability: 'nonpayable',
    name: 'setFeeBps',
    inputs: [
      { name: 'feeType', type: 'uint8' },
      { name: 'bps', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'FeeBpsUpdated',
    inputs: [
      { name: 'feeType', type: 'uint8', indexed: true },
      { name: 'previous', type: 'uint16', indexed: false },
      { name: 'current', type: 'uint16', indexed: false },
    ],
  },
] as const;
