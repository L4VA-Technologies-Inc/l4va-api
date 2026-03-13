/**
 * Input for creating NFT listing
 */
export interface NFTListingInput {
  policyId: string;
  assetName: string;
  priceAda: number;
}

/**
 * Input for unlisting NFT
 */
export interface UnlistInput {
  policyId: string;
  assetName: string; // Hex-encoded asset name
  txHashIndex: string; // Transaction hash where the NFT was listed (will be converted to txHash#outputIndex)
}

/**
 * Input for updating listing price
 */
export interface UpdateListingInput {
  policyId: string;
  assetName: string; // Hex-encoded asset name
  txHashIndex: string; // Transaction hash where the NFT was listed (will be converted to txHash#outputIndex)
  newPriceAda: number;
}

/**
 * Input for making offer on NFT
 */
export interface MakeOfferInput {
  policyId: string;
  assetName: string;
  priceAda: number;
}

/**
 * Input for buying NFT
 */
export interface BuyNFTInput {
  policyId: string;
  txHashIndex: string; // Format: txHash#outputIndex
  priceAda: number;
}

/**
 * Payload for creating NFT listing(s)
 */
export interface ListingPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  create: Array<{
    assets: {
      policyId: string;
      assetName: string;
    };
    priceAda: number;
  }>;
}

/**
 * Payload for unlisting NFT(s)
 */
export interface UnlistPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  message?: string;
  unlist: UnlistInput[];
}

/**
 * Payload for updating listing(s)
 */
export interface UpdateListingPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  message?: string;
  update: UpdateListingInput[];
}

/**
 * Payload for making offer(s)
 */
export interface MakeOfferPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  message?: string;
  createOffer: MakeOfferInput[];
}

/**
 * Payload for buying NFT(s)
 */
export interface BuyNFTPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  message?: string;
  buy: BuyNFTInput[];
}

/**
 * Combined marketplace actions input
 * Allows executing multiple types of marketplace operations in a single transaction
 */
export interface CombinedMarketplaceActionsInput {
  listings?: NFTListingInput[]; // NFTs to list for sale
  unlistings?: UnlistInput[]; // Listings to cancel
  updates?: UpdateListingInput[]; // Listings to update price
  offers?: MakeOfferInput[]; // Offers to make
  purchases?: BuyNFTInput[]; // NFTs to buy
}

/**
 * Generic WayUp transaction input for blockchain service
 */
export interface WayUpTransactionInput {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  message?: string;
  create?: {
    assets: { policyId: string; assetName: string };
    priceAda: number;
  }[];
  unlist?: {
    policyId: string;
    txHashIndex: string;
  }[];
  update?: {
    policyId: string;
    txHashIndex: string;
    newPriceAda: number;
  }[];
  createOffer?: {
    policyId: string;
    assetName: string;
    priceAda: number;
  }[];
  buy?: {
    policyId: string;
    txHashIndex: string;
    priceAda: number;
  }[];
}

/**
 * Query parameters for fetching collection assets from WayUp
 */
export interface GetCollectionAssetsQuery {
  policyId: string;
  limit?: number;
  cursor?: string;
  minPrice?: string; // lovelace
  maxPrice?: string; // lovelace
  minRarity?: string;
  maxRarity?: string;
  orderBy?: 'priceAsc' | 'priceDesc' | 'nameAsc' | 'idxAsc' | 'recentlyListed' | 'rarityAsc' | 'recentlyMinted';
  term?: string; // Full-text search term (name / attributes)
  listingType?: 'jpgstore' | 'wayup' | 'spacebudz';
  saleType?: 'all' | 'listedOnly' | 'bundles';
  properties?: Array<{ key: string; value: string }>;
}

/**
 * Listing information for an asset
 */
export interface WayUpListing {
  txHashIndex: string;
  price: number; // lovelace
  priceCurrency: string | null;
  bundleSize: number | null;
  isProcessing: boolean;
  type: 'jpgstore' | 'wayup' | 'spacebudz';
  version: 'v2' | 'v3';
  scriptHash: string;
}

/**
 * Collection metadata
 */
export interface WayUpCollection {
  policyId: string;
  name: string;
  handle?: string;
  verified: boolean;
  image?: string;
  banner?: string | null;
  description?: string | null;
  royaltyAddress?: string;
  royaltyPct?: number;
  socials?: Record<string, string>;
}

/**
 * Asset result from collection query
 */
export interface WayUpAssetResult {
  unit: string; // policyId.assetName (hex)
  policyId: string;
  assetName: string; // hex
  name: string; // readable
  image?: string;
  media?: { src: string; blur?: string };
  quantity: number;
  attributes?: Record<string, string>;
  rarity?: number | null;
  listing?: WayUpListing | null;
  collection?: WayUpCollection;
}

/**
 * Response from get-collection-assets endpoint
 */
export interface GetCollectionAssetsResponse {
  results: WayUpAssetResult[];
  pageState: string | null;
  count: number;
}
