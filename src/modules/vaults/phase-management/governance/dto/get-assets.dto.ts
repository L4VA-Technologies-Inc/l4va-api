import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class AssetBuySellDto {
  @ApiProperty({ description: 'Asset ID' })
  @Expose()
  id: string;

  @ApiProperty({ description: 'Asset name' })
  @Expose()
  @Transform(({ obj }) => {
    // Extract name from name field, onchainMetadata, or convert hex asset_name to string
    return (
      obj.name ||
      obj.metadata?.onchainMetadata?.name ||
      (obj.asset_name ? Buffer.from(obj.asset_name, 'hex').toString() : '')
    );
  })
  name: string;

  @ApiProperty({ description: 'Asset policy ID' })
  @Expose()
  policy_id: string;

  @ApiProperty({ description: 'Asset ID (hex-encoded asset name)' })
  @Expose()
  asset_id: string;

  @ApiProperty({ description: 'Asset quantity' })
  @Expose()
  quantity: string;

  @ApiPropertyOptional({ description: 'Asset floor price (in ADA)' })
  @Expose()
  floor_price: string | null;

  @ApiPropertyOptional({ description: 'Asset DEX price (in ADA)' })
  @Expose()
  dex_price: string | null;

  @ApiPropertyOptional({ description: 'Asset image URL' })
  @Expose()
  @Transform(({ obj }) => {
    const image = obj.image || obj.metadata?.onchainMetadata?.image;
    if (!image) return null;
    if (image.startsWith('ipfs://')) {
      return image.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }
    return image;
  })
  imageUrl: string | null;

  @ApiProperty({ description: 'Asset type (FT or NFT)' })
  @Expose()
  type: string;

  // Marketplace listing fields
  @ApiPropertyOptional({ description: 'Marketplace where asset is listed', example: 'wayup' })
  @Expose()
  listing_market?: string;

  @ApiPropertyOptional({ description: 'Listing price in ADA', example: '100.5' })
  @Expose()
  listing_price?: string;

  @ApiPropertyOptional({ description: 'Listing transaction hash' })
  @Expose()
  listing_tx_hash?: string;

  @ApiPropertyOptional({ description: 'Date when asset was listed' })
  @Expose()
  listed_at?: Date;

  // Computed fields for offer details
  @ApiPropertyOptional({ description: 'Formatted listing price with ADA suffix', example: '6.00 ADA' })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.listing_price) return null;
    return `${parseFloat(obj.listing_price).toFixed(2)} ADA`;
  })
  formattedListingPrice?: string;

  @ApiPropertyOptional({ description: 'Formatted floor price with ADA suffix', example: '6 ADA' })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.floor_price) return null;
    return `${obj.floor_price} ADA`;
  })
  formattedFloorPrice?: string;
}

// LP Pool DTOs for Termination
export class LpPoolDto {
  @ApiProperty({ description: 'DEX name', example: 'VyFinance' })
  dex: string;

  @ApiProperty({ description: 'LP token unit identifier' })
  lpTokenUnit: string;

  @ApiProperty({ description: 'ADA amount locked in pool', example: 50.5 })
  adaAmount: number;

  @ApiProperty({ description: 'VT amount locked in pool', example: 1000 })
  vtAmount: number;

  @ApiProperty({ description: 'Whether this LP can be automatically recovered' })
  isRecoverable: boolean;
}

export class TerminationLpInfoDto {
  @ApiProperty({ description: 'Whether vault has any LP pools' })
  hasLp: boolean;

  @ApiProperty({ description: 'Array of LP pools with recovery status', type: [LpPoolDto] })
  pools: LpPoolDto[];

  @ApiPropertyOptional({ description: 'LP token unit that can be recovered', nullable: true })
  recoverableLpTokenUnit: string | null;

  @ApiProperty({ description: 'Total ADA in unrecoverable pools', example: 0 })
  totalUnrecoverableAda: number;
}

export class TerminationValidationDto {
  @ApiProperty({ description: 'Whether termination proposal can be created' })
  canCreateProposal: boolean;

  @ApiProperty({ description: 'Array of warning messages', type: [String] })
  warnings: string[];

  @ApiPropertyOptional({ description: 'Reason why proposal creation is blocked', nullable: true })
  blockingReason: string | null;
}

export class GetTerminationAssetsDto {
  @ApiProperty({ description: 'Assets to be terminated', type: [AssetBuySellDto] })
  assets: AssetBuySellDto[];

  @ApiProperty({ description: 'LP pool information and validation', type: TerminationLpInfoDto })
  lpInfo: TerminationLpInfoDto;

  @ApiProperty({ description: 'Overall validation status', type: TerminationValidationDto })
  validation: TerminationValidationDto;
}
