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
  txHashIndex: string; // Format: txHash#outputIndex
}

/**
 * Input for updating listing price
 */
export interface UpdateListingInput {
  policyId: string;
  txHashIndex: string; // Format: txHash#outputIndex
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
  unlist: UnlistInput[];
}

/**
 * Payload for updating listing(s)
 */
export interface UpdateListingPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  update: UpdateListingInput[];
}

/**
 * Payload for making offer(s)
 */
export interface MakeOfferPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
  createOffer: MakeOfferInput[];
}

/**
 * Payload for buying NFT(s)
 */
export interface BuyNFTPayload {
  changeAddress: string;
  utxos: string[];
  collaterals?: string[];
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
