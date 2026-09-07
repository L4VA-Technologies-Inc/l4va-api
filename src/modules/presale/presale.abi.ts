/**
 * L4VAPresale — read surface + purchase event.
 *
 * Mirrors the ABI the l4va-org frontend uses (src/config/contracts.js). Only
 * the members this service actually reads are included. Phase enum:
 * 0 = INACTIVE, 1 = WHITELIST, 2 = PUBLIC, 3 = ENDED.
 */
export const PRESALE_ABI = [
  { name: 'phase', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },

  { name: 'totalSold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'hardCapL4va', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'remainingL4va', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  { name: 'ethUsdPrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'usdPriceWl', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'usdPricePublic', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  { name: 'maxPerWalletWl', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxPerWalletPublic', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minPerPurchaseWl', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'minPerPurchasePublic',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },

  { name: 'wlEndsAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'publicEndsAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  {
    name: 'purchased',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'whitelist',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },

  // Emitted on every buy(). Confirmed on-chain against the deployed contract:
  //   Purchased(address indexed buyer, uint256 l4vaAmount, uint256 ethPaid,
  //             uint256 ethRefunded, uint8 phase)
  // (the frontend's old `TokensPurchased` name never matched and never fired).
  {
    name: 'Purchased',
    type: 'event',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'l4vaAmount', type: 'uint256', indexed: false },
      { name: 'ethPaid', type: 'uint256', indexed: false },
      { name: 'ethRefunded', type: 'uint256', indexed: false },
      { name: 'phase', type: 'uint8', indexed: false },
    ],
  },
] as const;

/** Numeric phase values as reported by `phase()`. */
export const PRESALE_PHASE = {
  INACTIVE: 0,
  WHITELIST: 1,
  PUBLIC: 2,
  ENDED: 3,
} as const;
