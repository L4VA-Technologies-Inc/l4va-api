import { IsString, IsNumber, IsOptional, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class SocialLink {
  @ApiProperty()
  @IsString()
  @Expose()
  name: string;

  @ApiProperty()
  @IsUrl()
  @Expose()
  url: string;

  constructor(partial: Partial<SocialLink>) {
    Object.assign(this, partial);
  }
}

export class AssetWhiteList {
  /**
   * Policy ID of the asset (56-character hex string)
   * @example '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd'
   */
  @ApiProperty()
  @IsString()
  @Expose()
  policyId: string;

  /**
   * Minimum number of assets allowed
   * @example 1
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Expose()
  countCapMin?: number;

  /**
   * Maximum number of assets allowed
   * @example 10
   */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Expose()
  countCapMax?: number;

  constructor(partial: Partial<AssetWhiteList>) {
    Object.assign(this, partial);
  }
}

export class ContributorWhiteList {
  @ApiProperty()
  @IsString()
  @Expose()
  policyId: string;

  constructor(partial: Partial<ContributorWhiteList>) {
    Object.assign(this, partial);
  }
}

export class InvestorsWhiteList {
  @ApiProperty()
  @IsString()
  @Expose()
  walletAddress: string;

  constructor(partial: Partial<InvestorsWhiteList>) {
    Object.assign(this, partial);
  }
}
