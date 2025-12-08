import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';

export class AssetBuySellDto {
  @ApiProperty({ description: 'Asset ID' })
  @Expose()
  id: string;

  @ApiProperty({ description: 'Asset name' })
  @Expose()
  @Transform(({ obj }) => {
    // Extract name from onchainMetadata or convert hex asset_name to string
    return obj.metadata?.onchainMetadata?.name || (obj.asset_name ? Buffer.from(obj.asset_name, 'hex').toString() : '');
  })
  name: string;

  @ApiProperty({ description: 'Asset policy ID' })
  @Expose()
  policy_id: string;

  @ApiProperty({ description: 'Asset quantity' })
  @Expose()
  quantity: string;

  @ApiProperty({ description: 'Asset floor price (in ADA)', required: false })
  @Expose()
  floor_price: string | null;

  @ApiProperty({ description: 'Asset DEX price (in ADA)', required: false })
  @Expose()
  dex_price: string | null;

  @ApiProperty({ description: 'Asset image URL', required: false })
  @Expose()
  @Transform(({ obj }) => obj.metadata?.onchainMetadata?.image || null)
  imageUrl: string | null;

  @ApiProperty({ description: 'Asset type (FT or NFT)' })
  @Expose()
  type: string;
}
