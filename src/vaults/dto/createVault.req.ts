import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn'
}

export enum VaultPrivacy {
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private'
}

interface SocialLinks {
  facebook?: string;
  twitter?: string
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
  socialLinks?: SocialLinks
}
