import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNumber, IsOptional, Matches, IsEnum, ValidateIf, Min, Max, IsBoolean } from 'class-validator';

import { AssetValuationMethod } from '@/types/asset.types';

export class AssetWhitelistDto {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'Policy ID must be a 56-character hexadecimal string',
  })
  policyId: string;

  @ApiProperty({
    description: 'Asset name hex (used for FT/NFT verification lookup)',
    required: false,
    example: 'f6cee18b885e242e91e167e80a38543e58e6c6bd9a9af86e54d8ecef21c78948',
  })
  @IsOptional()
  @IsString()
  @Expose({ name: 'assetName' })
  assetName?: string;

  @ApiProperty({
    description: 'Display name returned by client/app logic',
    required: false,
    example: 'BERRY',
  })
  @IsOptional()
  @IsString()
  @Expose({ name: 'name' })
  name?: string;

  @ApiProperty({
    description: 'Amount/weight sent by client for lookup context',
    required: false,
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'count' })
  count?: number;

  @ApiProperty({
    description: 'Human-readable collection name (optional)',
    required: false,
    example: 'Relics of Magma - The Vita',
  })
  @IsOptional()
  @IsString()
  @Expose({ name: 'collectionName' })
  collectionName?: string;

  @ApiProperty({
    description: 'Optional policy name passed from client',
    required: false,
    example: 'BERRY',
  })
  @IsOptional()
  @IsString()
  @Expose({ name: 'policyName' })
  policyName?: string;

  @ApiProperty({
    description: 'Minimum number of assets allowed',
    required: false,
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'countCapMin' })
  countCapMin?: number;

  @ApiProperty({
    description: 'Maximum number of assets allowed',
    required: false,
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Expose({ name: 'countCapMax' })
  countCapMax?: number;

  @ApiProperty({
    description: 'Unique ID for the asset',
    required: false,
    example: 1456431,
  })
  @IsOptional()
  @IsNumber()
  uniqueId?: number;

  @ApiProperty({
    description: 'Valuation method for the asset',
    required: false,
    enum: AssetValuationMethod,
    example: AssetValuationMethod.MARKET,
    default: AssetValuationMethod.MARKET,
  })
  @IsOptional()
  @IsEnum(AssetValuationMethod)
  @Expose({ name: 'valuationMethod' })
  valuationMethod?: AssetValuationMethod;

  @ApiProperty({
    description: 'Custom price in ADA (required when valuationMethod is custom)',
    required: false,
    example: 100.5,
    minimum: 0.000001,
    maximum: 1000000,
  })
  @ValidateIf(o => o.valuationMethod === AssetValuationMethod.CUSTOM)
  @IsNumber()
  @Min(0.000001, { message: 'Custom price must be greater than 0' })
  @Max(1000000, { message: 'Custom price cannot exceed 1,000,000 ADA' })
  @Expose({ name: 'customPriceAda' })
  customPriceAda?: number;

  @ApiProperty({
    description: 'Client-side verification flag (backend still re-checks independently)',
    required: false,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;
}
