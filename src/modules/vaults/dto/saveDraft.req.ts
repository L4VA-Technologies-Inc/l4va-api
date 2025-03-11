import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import {ContributionWindowType, VaultPrivacy, VaultStatus, VaultType} from "../../../types/vault.types";

type SocialLink = {
  url:string,
  name: string,
}

type AssetWhiteList = {
  id: string,
}

export class SaveDraftReq {

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
  whitelistCsv: string;

  @ApiProperty()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  assetsWhitelist?: AssetWhiteList[]

  @ApiProperty()
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsObject({ each: true })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  socialLinks?: SocialLink[]
}
