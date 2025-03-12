import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString
} from 'class-validator';
import {ContributionWindowType, VaultPrivacy, VaultType} from '../../../types/vault.types';
import {AssetWhiteList, InvestorsWhiteList, SocialLink} from '../types';

export class CreateVaultReq {

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  name: string; // required

  @IsEnum(VaultType)
  @ApiProperty()
  type: VaultType; // required

  @IsEnum(VaultPrivacy)
  @ApiProperty()
  privacy: VaultPrivacy; // required

  @IsNotEmpty()
  fractionTokenTicker: string;  // required

  @IsNotEmpty()
  valuationType: string; // required

  @IsEnum(VaultType)
  @ApiProperty()
  contributionWindowType: ContributionWindowType;

  @IsNotEmpty()
  @ApiProperty()
  contributionWindowTime: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @ApiProperty()
  @IsNotEmpty()
  imageUrl: string;

  @ApiProperty()
  @IsNotEmpty()
  bannerUrl: string;

  @ApiProperty()
  @IsNotEmpty()
  assetsWhiteListCsv: string;


  @ApiProperty()
  @IsNotEmpty()
  investorsWitheListCsv: string;

  @ApiProperty()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  assetsWhiteList?: AssetWhiteList[];


  @ApiProperty()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  investorsWhiteList?: InvestorsWhiteList[];

  @ApiProperty()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  socialLinks?: SocialLink[];
}
