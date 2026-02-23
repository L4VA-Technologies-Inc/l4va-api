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
  IsNumberString,
  Matches,
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
  @IsNumberString({}, { message: 'price must be a valid numeric string' })
  price?: string;

  // ===== UPDATE_LISTING field =====
  @ApiProperty({
    description: 'New price in ADA (for UPDATE_LISTING)',
    required: false,
  })
  @IsOptional()
  @IsNumberString({}, { message: 'newPrice must be a valid numeric string' })
  newPrice?: string;

  // ===== BUY field =====
  @ApiProperty({
    description: 'Maximum price willing to pay in ADA (for BUY)',
    required: false,
  })
  @IsOptional()
  @IsNumberString({}, { message: 'maxPrice must be a valid numeric string' })
  maxPrice?: string;

  // ===== Common fields =====
  @ApiProperty({
    description: 'Market platform',
    default: 'WayUp',
  })
  @IsString()
  market: string;

  // ===== SWAP field (for DexHunter FT swaps) =====
  @ApiProperty({
    description: 'Slippage tolerance percentage (0.5-5%) for token swaps via DexHunter',
    required: false,
    example: 0.5,
  })
  @IsOptional()
  @IsNumber()
  slippage?: number;

  @ApiProperty({
    description: 'Use market price at execution time (true) or custom limit price (false)',
    required: false,
    default: true,
  })
  @IsOptional()
  useMarketPrice?: boolean;

  @ApiProperty({
    description: 'Custom limit price in ADA per token (used when useMarketPrice is false)',
    required: false,
  })
  @IsOptional()
  @IsNumber()
  customPriceAda?: number;

  @ApiProperty({
    description: 'Resolved asset IDs and quantities for DexHunter swaps (auto-populated by backend)',
    required: false,
  })
  @IsOptional()
  resolvedAssets?: Array<{
    assetId: string;
    quantity: number;
  }>;
}

export class ExpansionPolicyIdDto {
  @ApiProperty({
    description: 'Policy ID (56-character hexadecimal string)',
    example: '4d8a6e547e120c6094302e56039938bbe918d459a214b75e8b549fa0',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'Policy ID must be a 56-character hexadecimal string',
  })
  policyId: string;

  @ApiProperty({
    description: 'Human-readable label for the policy',
    example: '4d8a6e547e...8b549fa0',
    required: false,
  })
  @IsOptional()
  @IsString()
  label?: string;
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
    description: 'Amount to distribute in lovelace for distribution proposals (1 ADA = 1,000,000 lovelace)',
    example: 100000000,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Expose()
  distributionLovelaceAmount?: number;

  @ApiProperty({
    description: 'Marketplace actions for buy/sell proposals',
    type: [MarketplaceActionDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarketplaceActionDto)
  @Expose()
  marketplaceActions?: MarketplaceActionDto[];

  @ApiProperty({
    description: 'Proposal start time (as a string)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Expose()
  proposalStart?: string;

  // ===== EXPANSION fields =====
  @ApiProperty({
    description: 'Policy IDs of whitelisted asset collections for expansion',
    type: [ExpansionPolicyIdDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpansionPolicyIdDto)
  @Expose()
  expansionPolicyIds?: ExpansionPolicyIdDto[];

  @ApiProperty({
    description: 'Duration in milliseconds for vault expansion period',
    required: false,
    example: 604800000,
  })
  @IsOptional()
  @IsNumber()
  @Expose()
  expansionDuration?: number;

  @ApiProperty({
    description: 'No time limit for expansion period',
    required: false,
    default: false,
  })
  @IsOptional()
  @Expose()
  expansionNoLimit?: boolean;

  @ApiProperty({
    description: 'Maximum number of assets allowed for expansion (whole numbers only)',
    required: false,
    example: 100,
  })
  @IsOptional()
  @IsNumber()
  @Expose()
  expansionAssetMax?: number;

  @ApiProperty({
    description: 'No maximum for expansion assets',
    required: false,
    default: false,
  })
  @IsOptional()
  @Expose()
  expansionNoMax?: boolean;

  @ApiProperty({
    description: 'Pricing method for expansion: "limit" or "market"',
    required: false,
    enum: ['limit', 'market'],
    example: 'market',
  })
  @IsOptional()
  @IsString()
  @Expose()
  expansionPriceType?: 'limit' | 'market';

  @ApiProperty({
    description: 'Limit price per asset (VT per asset, up to 5 decimals) when using limit pricing',
    required: false,
    example: 1.5,
  })
  @IsOptional()
  @IsNumber()
  @Expose()
  expansionLimitPrice?: number;

  @ApiProperty({
    description: 'Additional metadata for the proposal',
    required: false,
    example: { assetId: 'xyz-123', targetPrice: '1000' },
  })
  @IsOptional()
  @Expose()
  metadata?: Record<string, any>;
}
