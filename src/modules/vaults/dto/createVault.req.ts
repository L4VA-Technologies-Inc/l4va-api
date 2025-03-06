import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import {VaultType} from "aws-sdk/clients/backup";
import {VaultPrivacy} from "../../../types/vault.types";

type SocialLink = {
  url:string,
  name: string,
}

type AssetWhiteList = {
  id: string,
}

export class CreateVaultReq {

  @IsNotEmpty()
  @ApiProperty()
  name: string;

  @IsNotEmpty()
  @ApiProperty()
  type: VaultType;

  @IsNotEmpty()
  @ApiProperty()
  privacy: VaultPrivacy;

  @ApiProperty()
  description?: string;

  @ApiProperty()
  imageUrl?: string;

  @ApiProperty()
  bannerUrl?: string;

  @ApiProperty()
  assetsWhitelist?: AssetWhiteList[]

  @ApiProperty()
  socialLinks?: SocialLink[]
}
