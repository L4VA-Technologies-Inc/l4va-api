import { ApiProperty } from '@nestjs/swagger';
import {
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
import { ContributionWindowType, VaultPrivacy, VaultType } from '../../../types/vault.types';
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

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  valuationType: string;

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
    description: 'Duration in PostgreSQL interval format (e.g., "2 days", "1 month", "14 days 12 hours")'
  })
  @IsNotEmpty()
  @IsString()
  contributionDuration: string;

  @ApiProperty()
  @IsNotEmpty()
  investmentWindowDuration: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  investmentOpenWindowType: string;

  @ApiProperty()
  @IsNotEmpty()
  investmentOpenWindowTime: string;

  @ApiProperty()
  @IsNotEmpty()
  offAssetsOffered: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  ftInvestmentReverse: number;

  @ApiProperty()
  @IsNotEmpty()
  liquidityPoolContribution: string;

  @ApiProperty()
  @IsNotEmpty()
  ftTokenSupply: string;

  @ApiProperty({
    description: 'Should be 1-10 characters'
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(1)
  @MaxLength(10)
  ftTokenTicker: string;

  @ApiProperty()
  @IsNotEmpty()
  ftTokenDecimals: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  terminationType: string;

  @ApiProperty()
  @IsNotEmpty()
  timeElapsedIsEqualToTime: string;

  @ApiProperty()
  @IsNotEmpty()
  assetAppreciation: string;

  @ApiProperty()
  @IsNotEmpty()
  creationThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
  startThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
  voteThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
  executionThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
  cosigningThreshold: string;

  @ApiProperty()
  @IsNotEmpty()
  ftTokenImg: string;

  @ApiProperty({
    description: 'List of whitelisted assets with their policy IDs and optional count caps',
    type: [AssetWhitelistDto],
    example: [{
      id: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
      countCapMin: 1,
      countCapMax: 10
    }]
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  assetsWhitelist: AssetWhitelistDto[];

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
