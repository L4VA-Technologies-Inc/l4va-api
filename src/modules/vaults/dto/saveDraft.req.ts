import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import {ContributionWindowType, VaultPrivacy, VaultType} from '../../../types/vault.types';
import {AssetWhiteList, InvestorsWhiteList, SocialLink} from '../types';

export class SaveDraftReq {

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum(VaultType)
  type?: VaultType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum(VaultPrivacy)
  privacy?: VaultPrivacy;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fractionTokenTicker?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  valuationType?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEnum(ContributionWindowType)
  contributionOpenWindowType?: ContributionWindowType;

  @ApiProperty({ required: false })
  @IsOptional()
  contributionOpenWindowTime?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bannerUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  assetsWhiteListCsv?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  investorsWhiteListCsv?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  assetWindow?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  assetCountCapMin?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  assetCountCapMax: number;

  @ApiProperty({ required: false })
  @IsOptional()
  investmentWindowDuration: string;

  @ApiProperty({ required: false })
  @IsOptional()
  investmentOpenWindowType: string;

  @ApiProperty({ required: false })
  @IsOptional()
  investmentOpenWindowTime: string;

  @ApiProperty({ required: false })
  @IsOptional()
  offAssetsOffered: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftInvestmentWindow: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftInvestmentReverse: number;

  @ApiProperty({ required: false })
  @IsOptional()
  liquidityPoolContribution: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftTokenSupply: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftTokenTicker: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftTokenDecimals: string;

  @ApiProperty({ required: false })
  @IsOptional()
  terminationType: string;

  @ApiProperty({ required: false })
  @IsOptional()
  timeElapsedIsEqualToTime: string;

  @ApiProperty({ required: false })
  @IsOptional()
  assetAppreciation: string;

  @ApiProperty({ required: false })
  @IsOptional()
  creationThreshold: string;

  @ApiProperty({ required: false })
  @IsOptional()
  startThreshold: string;

  @ApiProperty({ required: false })
  @IsOptional()
  voteThreshold: string;

  @ApiProperty({ required: false })
  @IsOptional()
  executionThreshold: string;

  @ApiProperty({ required: false })
  @IsOptional()
  cosigningThreshold: string;

  @ApiProperty({ required: false })
  @IsOptional()
  vaultImage: string;

  @ApiProperty({ required: false })
  @IsOptional()
  bannerImage: string;

  @ApiProperty({ required: false })
  @IsOptional()
  ftTokenImg: string;

  @ApiProperty( { required: false })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  assetsWhitelist?: AssetWhiteList[];

  @ApiProperty( { required: false })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  investorsWhiteList?: InvestorsWhiteList[];

  @ApiProperty({ required: false  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  socialLinks?: SocialLink[];
}
