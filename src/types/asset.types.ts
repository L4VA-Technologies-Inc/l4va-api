export enum AssetType {
  NFT = 'nft',
  FT = 'ft',
  ADA = 'ada',
  ETH = 'eth',
}

export enum AssetStatus {
  PENDING = 'pending',
  /** Asset is locked in the vault */
  LOCKED = 'locked',
  /** Removed from vault back to user (Cardano: cancellation claims, EVM: refunded contributions) */
  RELEASED = 'released',
  /** Status For ADA that have been sent across Contributors and LP */
  DISTRIBUTED = 'distributed',
  /** Asset has been moved to the treasury wallet */
  EXTRACTED = 'extracted',
  /** Asset is listed on marketplace */
  LISTED = 'listed',
  SOLD = 'sold',
  BURNED = 'burned',
  /** Active marketplace offer placed by vault treasury */
  OFFERED = 'offered',
  /** Offer was canceled or rejected on WayUp */
  CANCEL_OFFER = 'cancel_offer',
}

export enum AssetOriginType {
  ACQUIRED = 'acquired',
  CONTRIBUTED = 'contributed',
  FEE = 'fee',
  BOUGHT = 'bought',
  OFFERED = 'offered',
}

export enum AssetValuationMethod {
  MARKET = 'market',
  CUSTOM = 'custom',
  LP_TOKEN_DYNAMIC = 'lp_token_dynamic', // Calculate from pool TVL
}
