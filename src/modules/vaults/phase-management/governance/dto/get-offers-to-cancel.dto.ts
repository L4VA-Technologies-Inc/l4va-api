import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';

import { PaginationDto } from '@/modules/vaults/dto/pagination.dto';
import { AssetBuySellDto } from '@/modules/vaults/phase-management/governance/dto/get-assets.dto';

export class GetOffersToCancelDto extends PaginationDto {
  @IsString()
  @IsOptional()
  @ApiProperty({
    type: String,
    required: false,
    description: 'Search by NFT name, policy ID, or asset ID (hex)',
  })
  @Expose()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}

export class PaginatedOffersToCancelResponseDto {
  @ApiProperty({ type: [AssetBuySellDto], description: 'Offers that can be cancelled via CANCEL_OFFER proposal' })
  items: AssetBuySellDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  totalPages: number;
}
