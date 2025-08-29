import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, IsEnum, IsOptional, IsDateString, ValidateNested, IsArray } from 'class-validator';

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
  title: string;

  @ApiProperty({
    description: 'Detailed description of the proposal',
    example: 'Proposal to sell Asset XYZ at current market price...',
  })
  @IsNotEmpty()
  @IsString()
  description: string;

  @ApiProperty({
    description: 'Type of proposal',
    enum: ProposalType,
    example: ProposalType.DISTRIBUTION,
  })
  @IsEnum(ProposalType)
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
  startDate?: string;

  @ApiProperty({
    description: 'Fungible tokens for staking proposal',
    type: [FungibleTokenDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FungibleTokenDto)
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
  distributionAssets?: DistributionAssetDto[];

  @ApiProperty({
    description: 'Proposal start time (as a string)',
    required: false,
  })
  @IsOptional()
  @IsString()
  proposalStart?: string;

  @ApiProperty({
    description: 'Additional metadata for the proposal',
    required: false,
    example: { assetId: 'xyz-123', targetPrice: '1000' },
  })
  @IsOptional()
  metadata?: Record<string, any>;
}
