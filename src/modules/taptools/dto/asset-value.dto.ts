export class AssetValueDto {
  tokenId: string;
  name: string;
  displayName?: string;
  ticker?: string;
  quantity: number;
  isNft: boolean;
  isFungibleToken: boolean;
  priceAda: number;
  priceUsd: number;
  valueAda: number;
  valueUsd: number;
  metadata?: {
    policyId: string;
    fingerprint: string;
    decimals: number;
    description?: string;
    image?: string;
    assetName?: string;
    mintTx?: string;
    mintQuantity?: string;
    onchainMetadata?: Record<string, any>;
    mediaType?: string;
    files?: Array<{
      mediaType?: string;
      name?: string;
      src?: string;
    }>;
    attributes?: Record<string, any>;
  };
}
