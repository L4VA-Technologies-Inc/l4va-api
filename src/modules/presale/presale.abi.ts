/**
 * L4VAPresale — read surface + purchase event.
 *
 * Mirrors the ABI the l4va-org frontend uses (src/config/contracts.js). Only
 * the members this service actually reads are included, plus the quote helpers
 * the sale page calls directly.
 *
 * Phase enum: 0 = INACTIVE, 1 = ACTIVE, 2 = ENDED. Whitelist and public buy in
 * the same phase — the whitelist's only privilege is a flat discount, applied
 * in every tranche — so there is no separate WHITELIST/PUBLIC pair any more.
 */
export const PRESALE_ABI = [
  { name: 'phase', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },

  { name: 'totalSold', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'hardCapL4va', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'remainingL4va', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  { name: 'ethUsdPrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  // ── Tranche ladder ────────────────────────────────────────────────────────
  { name: 'currentTranche', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    name: 'remainingInCurrentTranche',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  { name: 'wlDiscountBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'trancheState',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'prices', type: 'uint256[4]' },
      { name: 'supplies', type: 'uint256[4]' },
      { name: 'sold', type: 'uint256[4]' },
      { name: 'current', type: 'uint8' },
    ],
  },

  // ── ETH contribution bands ────────────────────────────────────────────────
  { name: 'minEthTranche1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxEthTranche1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minEthLate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxEthLate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },

  // ── Sale window ───────────────────────────────────────────────────────────
  { name: 'saleEndsAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'saleDuration', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // Scheduled start: once `autoOpenAt` passes, the first buy (or anyone calling
  // `openIfScheduled`) opens the sale. `phase` reads 0 until that first tx.
  { name: 'autoOpenAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'saleOpenedAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },

  // ── Per-wallet ────────────────────────────────────────────────────────────
  {
    name: 'purchased',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'ethContributed',
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
  {
    name: 'limitsFor',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }],
    outputs: [
      { name: 'minEth', type: 'uint256' },
      { name: 'maxEth', type: 'uint256' },
      { name: 'remainingEth', type: 'uint256' },
    ],
  },

  // ── Quoting ───────────────────────────────────────────────────────────────
  {
    name: 'currentPriceUsd',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'previewBuy',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'ethAmount', type: 'uint256' },
    ],
    outputs: [
      { name: 'tokensOut', type: 'uint256' },
      { name: 'ethSpent', type: 'uint256' },
      { name: 'endTranche', type: 'uint8' },
    ],
  },

  // ── Buying ────────────────────────────────────────────────────────────────
  // ETH-in: the contract derives the token amount by walking the tranches.
  { name: 'buy', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },

  // Emitted on every buy().
  {
    name: 'Purchased',
    type: 'event',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'l4vaAmount', type: 'uint256', indexed: false },
      { name: 'ethPaid', type: 'uint256', indexed: false },
      { name: 'ethRefunded', type: 'uint256', indexed: false },
      { name: 'startTranche', type: 'uint8', indexed: false },
      { name: 'endTranche', type: 'uint8', indexed: false },
      { name: 'whitelisted', type: 'bool', indexed: false },
    ],
  },
  {
    name: 'TrancheAdvanced',
    type: 'event',
    inputs: [
      { name: 'previous', type: 'uint8', indexed: true },
      { name: 'current', type: 'uint8', indexed: true },
    ],
  },
] as const;

/** Numeric phase values as reported by `phase()`. */
export const PRESALE_PHASE = {
  INACTIVE: 0,
  ACTIVE: 1,
  ENDED: 2,
} as const;

/** Number of price tranches in the ladder. Fixed at four by the contract. */
export const TRANCHE_COUNT = 4;
