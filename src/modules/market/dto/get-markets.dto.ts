import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';

import { PaginationDto } from '../../vaults/dto/pagination.dto';

export enum Currency {
  ADA = 'ada',
  USD = 'usd',
}

export enum MarketSortField {
  supply = 'supply',
  fdv = 'fdv',
  price = 'price',
  ticker = 'ticker',
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
    description: 'Minimum fdv',
  })
  @Expose()
  minFdv?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    description: 'Maximum fdv',
  })
  @Expose()
  maxFdv?: number;

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
    description: 'Minimum FDV / TVL (%)',
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
    description: 'Maximum FDV / TVL (%)',
  })
  @Expose()
  maxDelta?: number;

  @IsEnum(Currency)
  @IsOptional()
  @ApiProperty({
    enum: Currency,
    required: false,
    default: Currency.ADA,
    description: 'Currency for filtering and sorting (ada or usd)',
  })
  @Expose()
  currency?: Currency = Currency.ADA;
}
