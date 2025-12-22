export enum AssetType {
  NFT = 'nft',
  FT = 'ft',
  ADA = 'ada',
}

export enum AssetStatus {
  PENDING = 'pending',
  LOCKED = 'locked', // Asset is locked in the vault
  RELEASED = 'released',
  DISTRIBUTED = 'distributed',
  EXTRACTED = 'extracted', // Asset has been extracted from the vault to the treasury wallet, and is sitting on it
  LISTED = 'listed',
  SOLD = 'sold',
}

export enum AssetOriginType {
  ACQUIRED = 'acquired',
  CONTRIBUTED = 'contributed',
  FEE = 'fee',
}
