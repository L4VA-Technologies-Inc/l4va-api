export class AssetValueDto {
    tokenId: string;
    name: string;
    quantity: number;
    isNft: boolean;
    isFungibleToken: boolean;
    priceAda?: number;
    priceUsd?: number;
    valueAda?: number;
    valueUsd?: number;
  }
  