export enum AssetType {
  NFT = 'nft',
  CNT = 'cnt',
  // Can be extended with more types as needed
}

export enum AssetStatus {
  PENDING = 'pending',
  LOCKED = 'locked',
  RELEASED = 'released',
  LISTED_FOR_SALE = 'listed_for_sale',
}

export enum AssetOriginType {
  INVESTED = 'invested',
  ACQUIRED = 'acquired',
  CONTRIBUTED = 'contributed',
}
