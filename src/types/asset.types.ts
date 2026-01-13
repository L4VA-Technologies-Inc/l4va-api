export enum AssetType {
  NFT = 'nft',
  FT = 'ft',
  ADA = 'ada',
}

export enum AssetStatus {
  PENDING = 'pending',
  /** Asset is locked in the vault */
  LOCKED = 'locked',
  /** Removed from vault back to user */
  RELEASED = 'released',
  /** Status For ADA that have been sent across Contributors and LP */
  DISTRIBUTED = 'distributed',
  /** Asset has been moved to the treasury wallet */
  EXTRACTED = 'extracted',
  /** Asset is listed on marketplace */
  LISTED = 'listed',
  SOLD = 'sold',
}

export enum AssetOriginType {
  ACQUIRED = 'acquired',
  CONTRIBUTED = 'contributed',
  FEE = 'fee',
}
