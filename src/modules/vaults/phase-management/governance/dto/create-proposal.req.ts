import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  IsEnum,
  IsOptional,
  IsDateString,
  ValidateNested,
  IsArray,
  IsNumber,
} from 'class-validator';

import { MarketplaceAction, ProposalType } from '@/types/proposal.types';

// Common FT asset class for staking
export class FungibleTokenDto {
  @ApiProperty({ description: 'Asset ID' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Amount to stake' })
  @IsNotEmpty()
  amount: number;
}

// Common NFT asset class for staking
export class NonFungibleTokenDto {
  @ApiProperty({ description: 'Asset ID' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Market ID' })
  @IsString()
  market: string;
}

export class DistributionAssetDto {
  @ApiProperty({ description: 'Asset ID' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ description: 'Amount to distribute' })
  @IsNotEmpty()
  amount: number;

  @ApiProperty({ description: 'Policy ID', required: false })
  @IsOptional()
  @IsString()
  policyId?: string;

  @ApiProperty({ description: 'Asset ID', required: false })
  @IsOptional()
  @IsString()
  assetId?: string;

  @ApiProperty({ description: 'Asset type', required: false })
  @IsOptional()
  @IsString()
  type?: string;
}

export class MarketplaceAssetDto {
  @ApiProperty({
    description: 'Marketplace action type',
    enum: MarketplaceAction,
    example: MarketplaceAction.SELL,
  })
  @IsEnum(MarketplaceAction)
  @IsNotEmpty()
  action: MarketplaceAction;

  @ApiProperty({ description: 'Asset ID in the system' })
  @IsString()
  @IsNotEmpty()
  assetId: string;

  @ApiProperty({ description: 'Asset name for display', required: false })
  @IsOptional()
  @IsString()
  assetName?: string;

  // For LIST and UPDATE_LISTING
  @ApiProperty({ description: 'Price in ADA', required: false })
  @IsOptional()
  @IsString()
  price?: string;

  @ApiProperty({ description: 'Duration in milliseconds', required: false })
  @IsOptional()
  @IsNumber()
  duration?: number;

  @ApiProperty({ description: 'Marketplace platform', required: false })
  @IsOptional()
  @IsString()
  market?: string;

  @ApiProperty({ description: 'Listing method (GTC or N/A)', required: false, enum: ['GTC', 'N/A'] })
  @IsOptional()
  @IsEnum(['GTC', 'N/A'])
  method?: 'GTC' | 'N/A';

  // For BUY
  @ApiProperty({ description: 'Maximum price for buy action', required: false })
  @IsOptional()
  @IsString()
  maxPrice?: string;

  @ApiProperty({ description: 'Quantity to buy/sell', required: false })
  @IsOptional()
  @IsString()
  quantity?: string;

  // For UNLIST
  @ApiProperty({ description: 'Listing ID to unlist', required: false })
  @IsOptional()
  @IsString()
  listingId?: string;
}

export class CreateProposalReq {
  @ApiProperty({
    description: 'Title of the proposal',
    example: 'Sell Asset XYZ',
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  title: string;

  @ApiProperty({
    description: 'Detailed description of the proposal',
    example: 'Proposal to sell Asset XYZ at current market price...',
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  description: string;

  @ApiProperty({
    description: 'Type of proposal',
    enum: ProposalType,
    example: ProposalType.DISTRIBUTION,
  })
  @IsEnum(ProposalType)
  @Expose()
  type: ProposalType;

  @ApiProperty({
    description: 'Start date and time when voting begins. If not provided, starts immediately.',
    example: '2025-08-05T10:00:00.000Z',
    type: 'string',
    format: 'date-time',
    required: true,
  })
  @IsNotEmpty()
  @IsDateString()
  @Expose()
  startDate: string;

  @ApiProperty({
    description: 'Voting duration.',
    example: '180000000',
    type: 'number',
    required: true,
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  duration: number;

  @ApiProperty({
    description: 'Fungible tokens for staking proposal',
    type: [FungibleTokenDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FungibleTokenDto)
  @Expose()
  fts?: FungibleTokenDto[];

  @ApiProperty({
    description: 'Non-fungible tokens for staking proposal',
    type: [NonFungibleTokenDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NonFungibleTokenDto)
  @Expose()
  nfts?: NonFungibleTokenDto[];

  @ApiProperty({
    description: 'Assets for distribution proposal',
    type: [DistributionAssetDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DistributionAssetDto)
  @Expose()
  distributionAssets?: DistributionAssetDto[];

  @ApiProperty({
    description: 'Proposal start time (as a string)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Expose()
  proposalStart?: string;

  @ApiProperty({
    description: 'Additional metadata for the proposal',
    required: false,
    example: { assetId: 'xyz-123', targetPrice: '1000' },
  })
  @IsOptional()
  @Expose()
  metadata?: Record<string, any>;
}

export enum ExecType {
  BUY = 'BUY',
  SELL = 'SELL',
  UNLIST = 'UNLIST',
  UPDATE_LISTING = 'UPDATE_LISTING',
}

export enum SellType {
  MARKET = 'Market',
  LIST = 'List',
}

export enum MethodType {
  NA = 'N/A',
  GTC = 'GTC',
}
export class MarketplaceActionDto {
  @ApiProperty({ description: 'Asset ID in the system' })
  @IsString()
  assetId: string;

  @ApiProperty({ description: 'Asset name for display' })
  @IsString()
  assetName: string;

  @ApiProperty({
    description: 'Action type: BUY, SELL, UNLIST, or UPDATE_LISTING',
    enum: ExecType,
  })
  @IsEnum(ExecType)
  exec: ExecType;

  // ===== SELL fields =====
  @ApiProperty({
    description: 'Quantity to buy/sell',
    required: false,
  })
  @IsOptional()
  @IsString()
  quantity?: string;

  @ApiProperty({
    description: 'Market or List sale type',
    enum: SellType,
    required: false,
  })
  @IsOptional()
  @IsEnum(SellType)
  sellType?: SellType;

  @ApiProperty({
    description: 'Duration in milliseconds',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  duration?: number;

  @ApiProperty({
    description: 'Method (N/A or GTC)',
    enum: MethodType,
    required: false,
  })
  @IsOptional()
  @IsEnum(MethodType)
  method?: MethodType;

  @ApiProperty({
    description: 'Price in ADA (for SELL)',
    required: false,
  })
  @IsOptional()
  @IsString()
  price?: string;

  // ===== UNLIST / UPDATE_LISTING / BUY fields =====
  @ApiProperty({
    description:
      'Transaction hash and output index (format: txHash#index) - Required for UNLIST, UPDATE_LISTING, and BUY',
    example: 'abc123def456...#0',
    required: false,
  })
  @IsOptional()
  @IsString()
  txHashIndex?: string;

  // ===== UPDATE_LISTING field =====
  @ApiProperty({
    description: 'New price in ADA (for UPDATE_LISTING)',
    required: false,
  })
  @IsOptional()
  @IsString()
  newPrice?: string;

  // ===== BUY field =====
  @ApiProperty({
    description: 'Maximum price willing to pay in ADA (for BUY)',
    required: false,
  })
  @IsOptional()
  @IsString()
  maxPrice?: string;

  // ===== Common fields =====
  @ApiProperty({
    description: 'Market platform',
    default: 'WayUp',
  })
  @IsString()
  market: string;
}
