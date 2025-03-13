import { IsString, IsNumber, IsOptional, IsUrl, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class SocialLink {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsUrl()
  url: string;
}

export interface AssetWhiteList {
  /**
   * Policy ID of the asset (56-character hex string)
   * @example '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd'
   */
  id: string;

  /**
   * Minimum number of assets allowed
   * @example 1
   */
  countCapMin?: number;

  /**
   * Maximum number of assets allowed
   * @example 10
   */
  countCapMax?: number;
}

export interface InvestorsWhiteList {
  wallet_address: string;
}
