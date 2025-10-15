import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AssetMetadataDto {
  @ApiProperty({ description: 'Asset policy ID' })
  @Expose()
  policyId: string;

  @ApiProperty({ description: 'Asset fingerprint', required: false })
  @Expose()
  fingerprint?: string;

  @ApiProperty({ description: 'Number of decimal places', required: false })
  @Expose()
  decimals?: number;

  @ApiProperty({ description: 'Asset description', required: false })
  @Expose()
  description?: string;

  @ApiProperty({ description: 'Asset image URL', required: false })
  @Expose()
  image?: string;

  @ApiProperty({ description: 'Asset name (hex)', required: false })
  @Expose()
  assetName?: string;

  @ApiProperty({ description: 'Initial mint transaction hash', required: false })
  @Expose()
  mintTx?: string;

  @ApiProperty({ description: 'Total minted quantity', required: false })
  @Expose()
  mintQuantity?: string;

  @ApiProperty({ description: 'On-chain metadata', required: false })
  @Expose()
  onchainMetadata?: Record<string, any>;

  @ApiProperty({ description: 'Asset media type', required: false })
  @Expose()
  mediaType?: string;

  @ApiProperty({
    description: 'Asset files array',
    required: false,
    type: 'array',
    items: {
      type: 'object',
      properties: {
        mediaType: { type: 'string' },
        name: { type: 'string' },
        src: { type: 'string' },
      },
    },
  })
  @Expose()
  files?: Array<{
    mediaType?: string;
    name?: string;
    src?: string;
  }>;

  @ApiProperty({ description: 'Asset attributes', required: false })
  @Expose()
  attributes?: Record<string, any>;

  @ApiProperty({ description: 'Whether this data is fallback', required: false })
  @Expose()
  fallback?: boolean;
}

export class AssetValueDto {
  @ApiProperty({ description: 'Asset token ID (policy_id + asset_name)' })
  @Expose()
  tokenId: string;

  @ApiProperty({ description: 'Asset name' })
  @Expose()
  name: string;

  @ApiProperty({ description: 'Asset display name', required: false })
  @Expose()
  displayName?: string;

  @ApiProperty({ description: 'Asset ticker symbol', required: false })
  @Expose()
  ticker?: string;

  @ApiProperty({ description: 'Asset quantity owned' })
  @Expose()
  quantity: number;

  @ApiProperty({ description: 'Whether this asset is an NFT' })
  @Expose()
  isNft: boolean;

  @ApiProperty({ description: 'Whether this asset is a fungible token' })
  @Expose()
  isFungibleToken: boolean;

  @ApiProperty({ description: 'Asset price in ADA' })
  @Expose()
  priceAda: number;

  @ApiProperty({ description: 'Asset price in USD' })
  @Expose()
  priceUsd: number;

  @ApiProperty({ description: 'Total value in ADA (price * quantity)' })
  @Expose()
  valueAda: number;

  @ApiProperty({ description: 'Total value in USD (price * quantity)' })
  @Expose()
  valueUsd: number;

  @ApiProperty({ description: 'Asset metadata', required: false, type: () => AssetMetadataDto })
  @Expose()
  metadata?: AssetMetadataDto;
}

// Keep the Blockfrost types here as well since they're imported in your service
export class BlockfrostOnchainMetadataDto {
  @ApiProperty({ description: 'Asset name from on-chain metadata', required: false })
  @Expose()
  name?: string;

  @ApiProperty({ description: 'Asset description from on-chain metadata', required: false })
  @Expose()
  description?: string;

  @ApiProperty({ description: 'Asset image URL from on-chain metadata', required: false })
  @Expose()
  image?: string;

  @ApiProperty({ description: 'Asset media type', required: false })
  @Expose()
  mediaType?: string;

  @ApiProperty({ description: 'Asset files array', required: false, type: 'array', items: { type: 'object' } })
  @Expose()
  files?: any[];

  @ApiProperty({ description: 'Asset attributes', required: false })
  @Expose()
  attributes?: Record<string, any>;
}

export class BlockfrostOffchainMetadataDto {
  @ApiProperty({ description: 'Asset name', example: 'nutcoin' })
  @Expose()
  name: string;

  @ApiProperty({ description: 'Asset description', example: 'The Nut Coin' })
  @Expose()
  description: string;

  @ApiProperty({ description: 'Asset ticker', required: false, example: 'nutc' })
  @Expose()
  ticker?: string | null;

  @ApiProperty({ description: 'Asset website', required: false, example: 'https://www.stakenuts.com/' })
  @Expose()
  url?: string | null;

  @ApiProperty({ description: 'Base64 encoded logo of the asset', required: false })
  @Expose()
  logo?: string | null;

  @ApiProperty({
    description: 'Number of decimal places of the asset unit',
    required: false,
    minimum: 0,
    maximum: 255,
    example: 6,
  })
  @Expose()
  decimals?: number | null;
}

export class BlockfrostAssetResponseDto {
  @ApiProperty({
    description: 'Hex-encoded asset full name',
    example: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e',
  })
  @Expose()
  asset: string;

  @ApiProperty({
    description: 'Policy ID of the asset',
    example: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a7',
  })
  @Expose()
  policy_id: string;

  @ApiProperty({
    description: 'Hex-encoded asset name of the asset',
    example: '6e7574636f696e',
    required: false,
  })
  @Expose()
  asset_name?: string | null;

  @ApiProperty({
    description: 'CIP14 based user-facing fingerprint',
    example: 'asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w',
  })
  @Expose()
  fingerprint: string;

  @ApiProperty({
    description: 'Current asset quantity',
    example: '12000',
  })
  @Expose()
  quantity: string;

  @ApiProperty({
    description: 'ID of the initial minting transaction',
    example: '6804edf9712d2b619edb6ac86861fe93a730693183a262b165fcc1ba1bc99cad',
  })
  @Expose()
  initial_mint_tx_hash: string;

  @ApiProperty({
    description: 'Count of mint and burn transactions',
    example: 1,
  })
  @Expose()
  mint_or_burn_count: number;

  @ApiProperty({
    description: 'On-chain metadata which SHOULD adhere to the valid standards',
    required: false,
    type: () => BlockfrostOnchainMetadataDto,
  })
  @Expose()
  onchain_metadata?: BlockfrostOnchainMetadataDto | null;

  @ApiProperty({
    description: 'Standard under which on-chain metadata is valid',
    enum: ['CIP25v1', 'CIP25v2', 'CIP68v1', 'CIP68v2', 'CIP68v3'],
    required: false,
  })
  @Expose()
  onchain_metadata_standard?: 'CIP25v1' | 'CIP25v2' | 'CIP68v1' | 'CIP68v2' | 'CIP68v3' | null;

  @ApiProperty({
    description: 'Arbitrary plutus data (CIP68)',
    required: false,
  })
  @Expose()
  onchain_metadata_extra?: string | null;

  @ApiProperty({
    description: 'Off-chain metadata fetched from GitHub based on network',
    required: false,
    type: () => BlockfrostOffchainMetadataDto,
  })
  @Expose()
  metadata?: BlockfrostOffchainMetadataDto | null;
}
