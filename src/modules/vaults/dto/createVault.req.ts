import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ContributionWindowType, ValuationType, VaultPrivacy, VaultType } from '../../../types/vault.types';
import { InvestorsWhitelist, ContributorWhitelist, SocialLink } from '../types';
import { AssetWhitelistDto } from './assetWhitelist.dto';
import { TagDto } from './tag.dto';

export class CreateVaultReq {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Expose()
  id?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @Expose()
  name: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(VaultType)
  @Expose()
  type: VaultType;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(VaultPrivacy)
  @Expose()
  privacy: VaultPrivacy;

  @ApiProperty({
    description: 'Valuation type - public vaults can only use LBE, private/semi-private can use LBE or fixed',
    enum: ValuationType
  })
  @IsNotEmpty()
  @IsEnum(ValuationType)
  @Expose()
  valuationType: ValuationType;

  @ApiProperty({
    description: 'Currency for fixed valuation (required when valuationType is fixed)',
    required: false,
    example: 'ADA'
  })
  @IsOptional()
  @IsString()
  @Expose()
  valuationCurrency?: string;

  @ApiProperty({
    description: 'Amount for fixed valuation (required when valuationType is fixed)',
    required: false,
    example: '1000000'
  })
  @IsOptional()
  @IsString()
  @Expose()
  valuationAmount?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(ContributionWindowType)
  @Expose()
  contributionOpenWindowType: ContributionWindowType;

  @ApiProperty()
  @IsNotEmpty()
  @Expose()
  contributionOpenWindowTime: number;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @Expose()
  description: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @Expose()
  vaultImage: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  @Expose()
  bannerImage: string;

  @ApiProperty({
    description: 'CSV file containing investors whitelist',
    required: false
  })
  @IsOptional()
  @IsString()
  @Expose()
  investorsWhitelistCsv?: string;

  @ApiProperty({
    description: 'CSV file containing contributors whitelist',
    required: false
  })
  @IsOptional()
  @IsString()
  @Expose()
  contributorWhitelistCsv?: string;

  @ApiProperty({
    description: 'List of contributor wallet addresses',
    required: false,
    type: [ContributorWhitelist]
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContributorWhitelist)
  @Expose()
  contributorWhitelist?: ContributorWhitelist[];

  @ApiProperty({
    description: 'Duration in milliseconds'
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  contributionDuration: number;

  @ApiProperty({
    description: 'Duration in milliseconds'
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  investmentWindowDuration: number;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @Expose()
  investmentOpenWindowType: string;

  @ApiProperty()
  @IsNotEmpty()
  @Expose()
  investmentOpenWindowTime: string;

  @ApiProperty({
    description: 'Percentage of assets offered',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  offAssetsOffered: number;

  @ApiProperty({
    description: 'FT investment reverse percentage',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  ftInvestmentReserve: number;

  @ApiProperty({
    description: 'Liquidity pool contribution percentage',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  liquidityPoolContribution: number;

  @ApiProperty({
    description: 'Total supply of FT tokens',
    required: true,
    default: '100000000'
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  ftTokenSupply: number = 100000000;

  @ApiProperty({
    description: 'Should be 1-10 characters'
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  @Expose()
  ftTokenTicker: string;

  @ApiProperty({
    description: 'Number of decimal places for the FT token',
    required: true,
    default: '2'
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  ftTokenDecimals: string = '2';

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @Expose()
  terminationType: string;

  @ApiProperty({
    description: 'Duration in milliseconds',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  @Expose()
  timeElapsedIsEqualToTime: number;

  @ApiProperty({
    description: 'Vault appreciation percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  vaultAppreciation: number;

  @ApiProperty({
    description: 'Creation threshold percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  creationThreshold: number;

  @ApiProperty({
    description: 'Start threshold percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  startThreshold: number;

  @ApiProperty({
    description: 'Vote threshold percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  voteThreshold: number;

  @ApiProperty({
    description: 'Execution threshold percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  executionThreshold: number;

  @ApiProperty({
    description: 'Cosigning threshold percentage (between 0.00 and 100.00)',
    required: true,
    minimum: 0,
    maximum: 100,
    type: Number
  })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Max(100)
  @Expose()
  cosigningThreshold: number;

  @ApiProperty()
  @IsNotEmpty()
  @Expose()
  ftTokenImg: string;

  @ApiProperty({
    description: 'List of whitelisted assets with their policy IDs and optional count caps (max 10 assets)',
    type: [AssetWhitelistDto],
    required: false,
    example: [{
      id: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      countCapMin: 1,
      countCapMax: 10
    }]
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsObject({ each: true })
  @Expose()
  assetsWhitelist?: AssetWhitelistDto[];

  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @Expose()
  investorsWhitelist: InvestorsWhitelist[];

  @ApiProperty({
    description: 'List of contributor wallet addresses (required for private vaults)',
    type: [ContributorWhitelist],
    required: false
  })
  @IsArray()
  @IsObject({ each: true })
  @ArrayNotEmpty({
    message: 'Contributor whitelist is required for private vaults and must not be empty'
  })
  @Expose()
  whitelistContributors?: ContributorWhitelist[];

  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @Expose()
  socialLinks: SocialLink[];

  @ApiProperty({
    description: 'List of tags for the vault',
    type: [TagDto],
    required: false
  })
  @IsArray()
  @IsOptional()
  @IsObject({ each: true })
  @Expose()
  tags?: TagDto[];
}
