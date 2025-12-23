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
}
