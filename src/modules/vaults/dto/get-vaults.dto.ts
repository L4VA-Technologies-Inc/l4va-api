import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

import { PaginationDto } from './pagination.dto';

export enum VaultFilter {
  open = 'open',
  locked = 'locked',
  contribution = 'contribution',
  acquire = 'acquire',
  published = 'published',
  draft = 'draft',
  failed = 'failed',
  terminated = 'terminated',
  all = 'all',
  govern = 'govern'
}

export enum VaultSortField {
  name = 'name',
  createdAt = 'created_at',
  updatedAt = 'updated_at',
  tvl = 'tvl',
  initialVaultOffered = 'acquire_reserve',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export enum VaultTagFilter {
  NFT = 'NFT',
  FT = 'FT',
  RWA = 'RWA',
  REAL_ESTATE = 'Real Estate',
  INSURANCE = 'Insurance',
  COMMODITY = 'Commodity',
  SYNTHETIC = 'Synthetic',
  EXOTIC = 'Exotic',
  PRECIOUS_METAL = 'Precious Metal',
  GEM = 'Gem',
  DEFI = 'DeFi',
  PFP = 'PFP',
  STAKING = 'Staking',
  DEPIN = 'DePin',
  STABLECOIN = 'Stablecoin',
  GOVERNANCE = 'Governance',
  DEX = 'DEX',
  GAMING = 'Gaming',
  MUSIC = 'Music',
  ART = 'Art',
  METAVERSE = 'Metaverse',
  UTILITY = 'Utility',
  COLLECTIBLE = 'Collectible',
  PROTOCOL = 'Protocol',
  LP_TOKEN = 'LP Token',
  WRAPPED = 'Wrapped',
}

export enum TVLCurrency {
  ADA = 'ADA',
  USD = 'USD',
}

export class DateRangeDto {
  @IsNotEmpty({
    message: 'from must be a valid ISO date string',
  })
  @ApiProperty({
    example: '2025-09-03T12:00:00.000Z',
    required: false,
    description: 'Start date of the range (ISO string)',
  })
  @Expose()
  @IsString()
  @Transform(({ value }) => {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  })
  from?: Date;

  @IsNotEmpty({
    message: 'to must be a valid ISO date string',
  })
  @ApiProperty({
    example: '2025-09-10T12:00:00.000Z',
    required: false,
    description: 'End date of the range (ISO string)',
  })
  @Expose()
  @IsString()
  @Transform(({ value }) => {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  })
  to?: Date;
}

export class GetVaultsDto extends PaginationDto {
  @IsEnum(VaultFilter)
  @IsOptional()
  @ApiProperty({ enum: VaultFilter, required: false })
  @Expose()
  filter?: VaultFilter;

  @IsEnum(VaultSortField)
  @IsOptional()
  @ApiProperty({
    enum: VaultSortField,
    required: false,
    description: 'Field to sort by',
  })
  @Expose()
  sortBy?: VaultSortField;

  @IsBoolean()
  @IsOptional()
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Filter to show only vaults user is participating in',
  })
  @Expose()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value === 'true';
    }
    return value;
  })
  myVaults?: boolean;

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

  // Vault Tags Filter
  @IsEnum(VaultTagFilter, { each: true })
  @IsOptional()
  @ApiProperty({
    enum: VaultTagFilter,
    isArray: true,
    required: false,
    description: 'Filter by vault tags',
  })
  @Expose()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return [value];
    }
    return value;
  })
  tags?: VaultTagFilter[];

  // Reserve Met Filter
  @IsBoolean()
  @IsOptional()
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Filter by whether reserve is met (true) or not met (false)',
  })
  @Expose()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value === 'true';
    }
    return value;
  })
  reserveMet?: boolean;

  // Initial % Vault Offered Range
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    maximum: 100,
    description: 'Minimum initial vault percentage offered',
  })
  @Expose()
  @Type(() => Number)
  minInitialVaultOffered?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    maximum: 100,
    description: 'Maximum initial vault percentage offered',
  })
  @Expose()
  @Type(() => Number)
  maxInitialVaultOffered?: number;

  @IsString()
  @IsOptional()
  @ApiProperty({
    type: String,
    required: false,
    description: 'Filter by asset whitelist (exact match)',
  })
  @Expose()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  assetWhitelist?: string;

  // TVL Range
  @IsNumber()
  @IsOptional()
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    description: 'Minimum TVL value',
  })
  @Expose()
  @Type(() => Number)
  minTvl?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @ApiProperty({
    type: Number,
    required: false,
    minimum: 0,
    description: 'Maximum TVL value',
  })
  @Expose()
  @Type(() => Number)
  maxTvl?: number;

  @IsEnum(TVLCurrency)
  @IsOptional()
  @ApiProperty({
    enum: TVLCurrency,
    required: false,
    default: TVLCurrency.USD,
    description: 'Currency for TVL filtering (ADA or USD)',
  })
  @Expose()
  tvlCurrency?: TVLCurrency = TVLCurrency.USD;

  // Contribution Window Filters
  @ApiProperty({
    type: DateRangeDto,
    required: false,
    description: 'Filter by contribution window date range',
  })
  @Expose()
  @Type(() => DateRangeDto)
  @IsOptional()
  contributionWindow?: DateRangeDto;

  // Acquire Window Filters
  @ApiProperty({
    type: DateRangeDto,
    required: false,
    description: 'Filter by acquire window date range',
  })
  @Expose()
  @Type(() => DateRangeDto)
  @IsOptional()
  acquireWindow?: DateRangeDto;

  @ApiProperty({
    type: String,
    description: 'User ID of the vault owner (used to get public vaults of another user)',
    example: 'user-uuid-1234',
  })
  @Expose()
  @IsOptional()
  ownerId?: string;

  @ApiProperty({
    type: String,
    description: 'Search vaults by policy id or name',
    example: 'VaultName or 32f03826f2816cdaae08714f3bddb447eaf48598700754f2ca1e8803',
  })
  @Expose()
  @IsOptional()
  search?: string;
}
