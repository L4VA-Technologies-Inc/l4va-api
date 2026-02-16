import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

import { AssetType } from '@/types/asset.types';

export class AssetsFilterDto {
  @Expose()
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (typeof value === 'string') {
      const ids = value
        .split(',')
        .map((id: string) => id.trim())
        .filter((id: string) => id.length > 0);
      return ids.length > 0 ? ids : undefined;
    }
    return Array.isArray(value) ? value : undefined;
  })
  @ApiProperty({
    description: 'Filter by policy IDs (comma-separated string)',
    example: 'policy123,policy456',
    type: String,
    required: false,
  })
  policyId?: string[];

  @Expose()
  @IsOptional()
  @IsEnum(AssetType)
  @ApiProperty({ description: 'Filter by asset type', enum: AssetType, required: false })
  type?: AssetType;
}

export class GetContributedAssetsReq {
  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Search term for filtering assets by name or contributor wallet address',
    example: 'NFT',
    required: false,
  })
  search?: string;

  @Expose()
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Page number', example: 1, default: 1 })
  page: number;

  @Expose()
  @IsInt()
  @Min(1)
  @ApiProperty({ description: 'Items per page', example: 10, default: 10 })
  limit: number;

  @Expose()
  @IsOptional()
  @ValidateNested()
  @Type(() => AssetsFilterDto)
  @ApiProperty({ description: 'Asset filters', type: AssetsFilterDto, required: false })
  filter?: AssetsFilterDto;
}
