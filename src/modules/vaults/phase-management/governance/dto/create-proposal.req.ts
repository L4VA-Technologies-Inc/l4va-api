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
  IsBoolean,
} from 'class-validator';

import { ProposalType } from '@/types/proposal.types';

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
    required: false,
  })
  @IsOptional()
  @IsDateString()
  @Expose()
  startDate?: string;

  @ApiProperty({
    description: 'Voting duration.',
    example: '2025-08-05T10:00:00.000Z',
    type: 'string',
    format: 'date-time',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  @Expose()
  duration?: string;

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
}

export enum SellType {
  MARKET = 'Market',
  LIST = 'List',
}

export enum MethodType {
  NA = 'N/A',
  GTC = 'GTC',
}

export class BuyingSellOptionDto {
  @ApiProperty({ description: 'Asset ID in the system' })
  @IsString()
  assetId: string;

  @ApiProperty({ description: 'Asset name for display' })
  @IsString()
  assetName: string;

  @ApiProperty({ description: 'Buy or sell', enum: ExecType })
  @IsEnum(ExecType)
  exec: ExecType;

  @ApiProperty({ description: 'Quantity to buy/sell' })
  @IsString()
  quantity: string;

  @ApiProperty({ description: 'Market or List sale type', enum: SellType })
  @IsEnum(SellType)
  sellType: SellType;

  @ApiProperty({ description: 'Duration in milliseconds' })
  @IsNumber()
  duration: number;

  @ApiProperty({ description: 'Is maximum quantity flag' })
  @IsBoolean()
  isMax: boolean;

  @ApiProperty({ description: 'Method (N/A or GTC)', enum: MethodType })
  @IsEnum(MethodType)
  method: MethodType;

  @ApiProperty({ description: 'Market platform' })
  @IsString()
  market: string;

  @ApiProperty({ description: 'Price in ADA' })
  @IsString()
  price: string;
}

export class BuyingSellMetadataDto {
  @ApiProperty({ description: 'List of buying/selling options' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BuyingSellOptionDto)
  buyingSellingOptions: BuyingSellOptionDto[];

  @ApiProperty({ description: 'Proposal start delay in milliseconds' })
  @IsNumber()
  proposalStart: number;

  @ApiProperty({ description: 'Allow abstain voting' })
  @IsBoolean()
  abstain: boolean;
}
