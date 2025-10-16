import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsEnum, IsArray } from 'class-validator';

export class PaginationQueryDto {
  @ApiProperty({ description: 'Wallet address' })
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({ description: 'Page number', default: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ description: 'Items per page', default: 20, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiProperty({
    description: 'Filter by asset type',
    enum: ['all', 'nfts', 'tokens'],
    default: 'all',
    required: false,
  })
  @IsOptional()
  @IsEnum(['all', 'nfts', 'tokens'])
  filter?: 'all' | 'nfts' | 'tokens' = 'all';

  @ApiProperty({
    description: 'Array of whitelisted policy IDs',
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  whitelistedPolicies?: string[] = [];
}

export class PaginationMetaDto {
  @ApiProperty({ description: 'Current page number' })
  @Expose()
  page: number;

  @ApiProperty({ description: 'Items per page' })
  @Expose()
  limit: number;

  @ApiProperty({ description: 'Total number of items' })
  @Expose()
  total: number;

  @ApiProperty({ description: 'Total number of pages' })
  @Expose()
  totalPages: number;

  @ApiProperty({ description: 'Whether there is a next page' })
  @Expose()
  hasNextPage: boolean;

  @ApiProperty({ description: 'Whether there is a previous page' })
  @Expose()
  hasPrevPage: boolean;
}
