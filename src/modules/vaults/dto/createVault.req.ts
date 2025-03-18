import { ApiProperty } from '@nestjs/swagger';
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
} from 'class-validator';
import { ContributionWindowType, ValuationType, VaultPrivacy, VaultType } from '../../../types/vault.types';
import { InvestorsWhiteList, SocialLink } from '../types';
import { AssetWhitelistDto } from './assetWhitelist.dto';
import { TagDto } from './tag.dto';

export class CreateVaultReq {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(VaultType)
  type: VaultType;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(VaultPrivacy)
  privacy: VaultPrivacy;

  @ApiProperty({
    description: 'Valuation type - public vaults can only use LBE, private/semi-private can use LBE or fixed',
    enum: ValuationType
  })
  @IsNotEmpty()
  @IsEnum(ValuationType)
  valuationType: ValuationType;

  @ApiProperty({
    description: 'Currency for fixed valuation (required when valuationType is fixed)',
    required: false,
    example: 'ADA'
  })
  @IsOptional()
  @IsString()
  valuationCurrency?: string;

  @ApiProperty({
    description: 'Amount for fixed valuation (required when valuationType is fixed)',
    required: false,
    example: '1000000'
  })
  @IsOptional()
  @IsString()
  valuationAmount?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsEnum(ContributionWindowType)
  contributionOpenWindowType: ContributionWindowType;

  @ApiProperty()
  @IsNotEmpty()
  contributionOpenWindowTime: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  description: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  vaultImage: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  bannerImage: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  investorsWhiteListCsv?: string;

  @ApiProperty({
    description: 'Duration in milliseconds'
  })
  @IsNotEmpty()
  @IsNumber()
  contributionDuration: number;

  @ApiProperty({
    description: 'Duration in milliseconds'
  })
  @IsNotEmpty()
  @IsNumber()
  investmentWindowDuration: number;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  investmentOpenWindowType: string;

  @ApiProperty()
  @IsNotEmpty()
  investmentOpenWindowTime: string;

  @ApiProperty({
    description: 'Percentage of assets offered',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  offAssetsOffered: string;

  @ApiProperty({
    description: 'FT investment reverse percentage',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  ftInvestmentReverse: number;

  @ApiProperty({
    description: 'Liquidity pool contribution percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  liquidityPoolContribution: string;

  @ApiProperty({
    description: 'Total supply of FT tokens',
    required: true,
    default: '100000000'
  })
  @IsNotEmpty()
  @IsString()
  ftTokenSupply: string = '100000000';

  @ApiProperty({
    description: 'Should be 1-10 characters'
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  ftTokenTicker: string;

  @ApiProperty({
    description: 'Number of decimal places for the FT token',
    required: true,
    default: '2'
  })
  @IsNotEmpty()
  @IsString()
  ftTokenDecimals: string = '2';

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  terminationType: string;

  @ApiProperty({
    description: 'Duration in milliseconds',
    required: true
  })
  @IsNotEmpty()
  @IsNumber()
  timeElapsedIsEqualToTime: number;

  @ApiProperty({
    description: 'Vault appreciation percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  vaultAppreciation: string;

  @ApiProperty({
    description: 'Creation threshold percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  creationThreshold: string;

  @ApiProperty({
    description: 'Start threshold percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  startThreshold: string;

  @ApiProperty({
    description: 'Vote threshold percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  voteThreshold: string;

  @ApiProperty({
    description: 'Execution threshold percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  executionThreshold: string;

  @ApiProperty({
    description: 'Cosigning threshold percentage',
    required: true
  })
  @IsNotEmpty()
  @IsString()
  cosigningThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
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
  assetsWhitelist?: AssetWhitelistDto[];

  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  investorsWhiteList: InvestorsWhiteList[];

  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  socialLinks: SocialLink[];

  @ApiProperty({
    description: 'List of tags for the vault',
    type: [TagDto],
    required: false
  })
  @IsArray()
  @IsOptional()
  @IsObject({ each: true })
  tags?: TagDto[];
}
