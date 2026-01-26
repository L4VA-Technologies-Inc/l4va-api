import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

import { PaginationDto } from '../../vaults/dto/pagination.dto';

export enum TvlCurrency {
  ADA = 'ada',
  USD = 'usd',
}

export enum MarketSortField {
  circSupply = 'circSupply',
  fdv = 'fdv',
  mcap = 'mcap',
  price = 'price',
  ticker = 'ticker',
  totalSupply = 'totalSupply',
  priceChange1h = 'price_change_1h',
  priceChange24h = 'price_change_24h',
  priceChange7d = 'price_change_7d',
  priceChange30d = 'price_change_30d',
  tvl = 'tvl',
  delta = 'delta',
  createdAt = 'created_at',
  updatedAt = 'updated_at',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class GetMarketsDto extends PaginationDto {
  @IsEnum(MarketSortField)
  @IsOptional()
  @ApiProperty({
    enum: MarketSortField,
    required: false,
    description: 'Field to sort by',
  })
  @Expose()
  sortBy?: MarketSortField;

  @IsEnum(SortOrder)
  @IsOptional()
  @ApiProperty({
    enum: SortOrder,
    required: false,
    default: SortOrder.DESC,
    description: 'Sort order (ASC or DESC)',
  })
  @Expose()
  sortOrder?: SortOrder = SortOrder.DESC;

  @IsString()
  @IsOptional()
  @ApiProperty({
    type: String,
    required: false,
    description: 'Filter by ticker (case-insensitive partial match)',
  })
  @Expose()
  ticker?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Minimum price',
  })
  @Expose()
  minPrice?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Maximum price',
  })
  @Expose()
  maxPrice?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Minimum market cap',
  })
  @Expose()
  minMcap?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Maximum market cap',
  })
  @Expose()
  maxMcap?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Minimum TVL',
  })
  @Expose()
  minTvl?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Maximum TVL',
  })
  @Expose()
  maxTvl?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Minimum Mkt Cap / TVL (%)',
  })
  @Expose()
  minDelta?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Maximum Mkt Cap / TVL (%)',
  })
  @Expose()
  maxDelta?: number;

  @IsEnum(TvlCurrency)
  @IsOptional()
  @ApiProperty({
    enum: TvlCurrency,
    required: false,
    default: TvlCurrency.ADA,
    description: 'Currency for TVL filtering and sorting (ada or usd)',
  })
  @Expose()
  tvlCurrency?: TvlCurrency = TvlCurrency.ADA;
}
