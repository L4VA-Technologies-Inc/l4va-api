import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class AssetItemDto {
  @Expose()
  @ApiProperty({ description: 'Asset ID', example: 'uuid' })
  id: string;

  @Expose({ name: 'policy_id' })
  @ApiProperty({ description: 'Policy ID', example: 'policy123...' })
  policyId: string;

  @Expose({ name: 'asset_id' })
  @ApiProperty({ description: 'Asset ID (hex)', example: 'asset456...' })
  assetId: string;

  @Expose()
  @ApiProperty({ description: 'Asset type', enum: ['nft', 'ft'], example: 'nft' })
  type: string;

  // Map from Asset entity's normalizedQuantity getter (auto-adjusts for decimals)
  @Expose({ name: 'normalizedQuantity' })
  @ApiProperty({ description: 'Quantity (adjusted for decimals in FTs)', example: 1 })
  quantity: number;

  @Expose({ name: 'floor_price' })
  @ApiProperty({ description: 'Floor price in ADA (adjusted for decimals in FTs)', example: 100.5, required: false })
  floorPrice?: number;

  @Expose({ name: 'dex_price' })
  @ApiProperty({ description: 'DEX price in ADA (adjusted for decimals in FTs)', example: 0.5, required: false })
  dexPrice?: number;

  @Expose()
  @ApiProperty({ description: 'Floor price in USD', example: 50.25, required: false })
  floorPriceUsd?: number;

  @Expose()
  @ApiProperty({ description: 'Total value in ADA', example: 100.5 })
  valueAda: number;

  @Expose()
  @ApiProperty({ description: 'Total value in USD', example: 50.25 })
  valueUsd: number;

  @Expose()
  @ApiProperty({ description: 'Asset status', example: 'locked' })
  status: string;

  @Expose({ name: 'origin_type' })
  @ApiProperty({ description: 'Origin type', example: 'contributed' })
  originType: string;

  @Expose()
  @ApiProperty({ description: 'Asset image URL', required: false })
  image?: string;

  @Expose()
  @ApiProperty({ description: 'Number of decimals for FT tokens', example: 6, required: false })
  decimals?: number;

  @Expose()
  @ApiProperty({ description: 'Asset name', example: 'My NFT', required: false })
  name?: string;

  @Expose()
  @ApiProperty({ description: 'Asset description', required: false })
  description?: string;

  @Expose({ name: 'added_at' })
  @ApiProperty({ description: 'Date added', example: '2024-01-01T00:00:00Z' })
  addedAt: Date;

  @Expose({ name: 'updated_at' })
  @ApiProperty({ description: 'Date updated', example: '2024-01-01T00:00:00Z' })
  updatedAt: Date;

  @Expose({ name: 'locked_at' })
  @ApiProperty({ description: 'Date locked', required: false })
  lockedAt?: Date;

  @Expose({ name: 'released_at' })
  @ApiProperty({ description: 'Date released', required: false })
  releasedAt?: Date;

  @Expose({ name: 'last_valuation' })
  @ApiProperty({ description: 'Last valuation date', required: false })
  lastValuation?: Date;

  @Expose({ name: 'added_by' })
  @ApiProperty({ description: 'User who added the asset', type: Object, required: false })
  addedBy?: {
    id: string;
    address: string;
    profileImage?: string | null;
    bannerImage?: string | null;
  };
}

export class AssetsStatisticsDto {
  @Expose()
  @ApiProperty({
    description: 'Total combined value of all assets in ADA (includes contributed, bought, and fee assets)',
    example: 1000.5,
  })
  totalAssetValueAda: number;

  @Expose()
  @ApiProperty({
    description: 'Total combined value of all assets in USD (includes contributed, bought, and fee assets)',
    example: 500.25,
  })
  totalAssetValueUsd: number;

  @Expose()
  @ApiProperty({
    description: 'Average value per token in ADA (total value ÷ total tokens, includes all assets)',
    example: 3.98,
  })
  assetsAvgAda: number;

  @Expose()
  @ApiProperty({
    description: 'Average value per token in USD (total value ÷ total tokens, includes all assets)',
    example: 1.0,
  })
  assetsAvgUsd: number;

  @Expose()
  @ApiProperty({
    description: 'Total quantity of NFT assets (count of individual NFTs)',
    example: 50,
  })
  totalNFTAssets: number;

  @Expose()
  @ApiProperty({
    description: 'Total quantity of FT assets (adjusted for decimals to show actual token count)',
    example: 424.5,
  })
  totalFTAssets: number;
}

export class GetContributedAssetsRes {
  @Expose()
  @Type(() => AssetItemDto)
  @ApiProperty({ description: 'List of assets', type: [AssetItemDto] })
  items: AssetItemDto[];

  @Expose()
  @ApiProperty({ description: 'Total number of assets', example: 100 })
  total: number;

  @Expose()
  @ApiProperty({ description: 'Current page number', example: 1 })
  page: number;

  @Expose()
  @ApiProperty({ description: 'Items per page', example: 10 })
  limit: number;

  @Expose()
  @ApiProperty({ description: 'Total number of pages', example: 10 })
  totalPages: number;

  @Expose()
  @Type(() => AssetsStatisticsDto)
  @ApiProperty({ description: 'Asset statistics', type: AssetsStatisticsDto })
  statistics: AssetsStatisticsDto;
}
