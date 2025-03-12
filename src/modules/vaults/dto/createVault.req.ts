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
} from 'class-validator';
import { ContributionWindowType, VaultPrivacy, VaultType } from '../../../types/vault.types';
import { AssetWhiteList, InvestorsWhiteList, SocialLink } from '../types';

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
  @IsNotEmpty()
  @IsString()
  bannerImage: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  assetsWhiteListCsv: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  investorsWhiteListCsv?: string;

  @ApiProperty()
  @IsNotEmpty()
  assetWindow: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  assetCountCapMin: number;

  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  assetCountCapMax: number;

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
  ftInvestmentWindow: string;

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

  @ApiProperty()
  @IsNotEmpty()
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

  @ApiProperty()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  assetsWhitelist: AssetWhiteList[];

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
}
