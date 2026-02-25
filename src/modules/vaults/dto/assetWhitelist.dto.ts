import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNumber, IsOptional, Matches, IsEnum, ValidateIf, Min, Max } from 'class-validator';

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
    description: 'Human-readable collection name (optional)',
    required: false,
    example: 'Relics of Magma - The Vita',
  })
  @IsOptional()
  @IsString()
  @Expose({ name: 'collectionName' })
  collectionName?: string;

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
}
