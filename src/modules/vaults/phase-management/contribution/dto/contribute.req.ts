import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type, Transform } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, ValidateNested, Min, Max, IsNumber } from 'class-validator';

import { AssetType } from '@/types/asset.types';

// Maximum safe quantity to prevent database overflow and JS precision loss
// Using Number.MAX_SAFE_INTEGER (2^53 - 1) = 9,007,199,254,740,991
export const MAX_SAFE_QUANTITY = Number.MAX_SAFE_INTEGER;

export class ContributionAsset {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @IsNotEmpty()
  @Expose()
  policyId: string;

  @ApiProperty({
    description: 'Type of the asset, e.g. "ada", "ft", "nft"',
    example: 'ada',
  })
  @IsNotEmpty()
  @Expose()
  type: AssetType;

  @ApiProperty({
    description: 'Asset name within the policy',
    example: 'l4vaaudiEngine',
  })
  @IsNotEmpty()
  @Expose()
  assetName: string;

  @ApiProperty({
    description:
      'Quantity of assets to contribute in raw blockchain units (e.g., 3500000 for 3.5 tokens with 6 decimals). For NFTs, this is always 1.',
    example: 3500000,
    minimum: 1,
    maximum: 9007199254740991,
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(1, { message: 'Quantity must be at least 1 (raw units)' })
  @Max(MAX_SAFE_QUANTITY, { message: 'Quantity exceeds maximum safe value (9,007,199,254,740,991)' })
  @Expose()
  quantity: number;

  @ApiPropertyOptional({
    description: 'Display name of the asset (used for UI and stored as asset name)',
    example: 'Pxlz8876',
  })
  @Expose()
  @IsOptional()
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Asset image URL or IPFS path',
    example: 'ipfs://QmXBGeSKUfMs6ZuTDqYG9Luc72ehP3Jv9v4763x2Gox84B',
  })
  @Expose()
  @IsOptional()
  image?: string;

  @ApiPropertyOptional({
    description: 'Price of the asset in ADA',
    example: 250,
  })
  @Expose()
  @IsOptional()
  priceAda?: number;

  @ApiPropertyOptional({
    description: 'Price of the asset in USD',
    example: 65.45,
  })
  @Expose()
  @IsOptional()
  priceUsd?: number;

  @ApiPropertyOptional({
    description: 'Total value in ADA (price × quantity)',
    example: 250,
  })
  @Expose()
  @IsOptional()
  valueAda?: number;

  @ApiPropertyOptional({
    description: 'Total value in USD (price × quantity)',
    example: 65.45,
  })
  @Expose()
  @IsOptional()
  valueUsd?: number;

  @ApiPropertyOptional({
    description: 'Asset description',
    example: 'Pxlz NFT (example for testnet only - assets have no value)',
  })
  @Expose()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Number of decimals for fungible tokens',
    example: 0,
  })
  @Expose()
  @IsOptional()
  decimals?: number;

  @ApiPropertyOptional({
    description: 'Asset metadata including on-chain details',
    type: 'object',
    additionalProperties: true,
    example: {
      policyId: 'c365b10e9d9400767d234315841c6dd750a1b681d2ae069d4191ed6e',
      fingerprint: 'asset1tt9r6rl0dnft95w6smsaacg86sylf47hxkaz40',
      decimals: 0,
      description: '',
      image: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
      mediaType: 'image/png',
      files: [
        {
          src: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
          name: 'Igor 3',
          mediaType: 'image/png',
        },
      ],
      attributes: {},
      assetName: '4c34766149676f722033',
      mintTx: '98ec166ee46a4e56d9cadf28848a99e28ea4703f478c6c3aef4bd1553866667c',
      mintQuantity: '1',
      onchainMetadata: {
        name: 'Igor 3',
        files: [
          {
            src: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
            name: 'Igor 3',
            mediaType: 'image/png',
          },
        ],
        image: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
        owner: 'L4va',
        mediaType: 'image/png',
        description: '',
      },
    },
  })
  @Expose()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }
    return value || {};
  })
  metadata?: Record<string, any>;
}

export class ContributeReq {
  @ApiProperty({
    type: [ContributionAsset],
    description: 'List of assets to contribute',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContributionAsset)
  @Expose()
  assets: ContributionAsset[];
}
