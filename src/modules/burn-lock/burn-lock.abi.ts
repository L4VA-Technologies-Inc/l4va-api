/**
 * L4VABurnLock — the subset the keeper uses.
 *
 * `burn()` is permissionless and burns exactly what the on-chain schedule
 * allows (1,000,000 L4VA per day, missed days carried over), so the keeper
 * cannot over- or under-burn; it only has to call it.
 */
export const BURN_LOCK_ABI = [
  { name: 'burn', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'burnable', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'started', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'currentDay', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nextBurnAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBurned', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'lockedBalance', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'Burned',
    type: 'event',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'dayIndex', type: 'uint256', indexed: false },
      { name: 'totalBurned', type: 'uint256', indexed: false },
    ],
  },
  { name: 'NothingToBurn', type: 'error', inputs: [] },
  { name: 'NotStarter', type: 'error', inputs: [] },
] as const;
