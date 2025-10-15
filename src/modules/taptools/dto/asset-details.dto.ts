import { ApiProperty } from '@nestjs/swagger';

import { BlockfrostAssetResponseDto } from './asset-value.dto';

export class AssetDetailsDto extends BlockfrostAssetResponseDto {
  @ApiProperty({ description: 'Decoded asset name (from hex)', required: false })
  decodedName?: string;

  @ApiProperty({ description: 'Whether this asset is an NFT (quantity = 1)' })
  isNft: boolean;

  @ApiProperty({ description: 'Whether this asset is a fungible token (quantity > 1)' })
  isFungibleToken: boolean;

  @ApiProperty({ description: 'Asset price in ADA', required: false })
  priceAda?: number;

  @ApiProperty({ description: 'Asset price in USD', required: false })
  priceUsd?: number;

  @ApiProperty({ description: 'Whether this data was retrieved from cache' })
  cached?: boolean;

  @ApiProperty({ description: 'Whether this data is fallback data due to API limits' })
  fallback?: boolean;
}
