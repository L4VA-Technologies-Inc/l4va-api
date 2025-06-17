import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsNumber, IsOptional, IsUrl } from 'class-validator';

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

export class AssetWhitelist {
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

  constructor(partial: Partial<AssetWhitelist>) {
    Object.assign(this, partial);
  }
}

export class ContributorWhitelist {
  @ApiProperty()
  @IsString()
  @Expose()
  policyId: string;

  constructor(partial: Partial<ContributorWhitelist>) {
    Object.assign(this, partial);
  }
}

export class AcquirerWhitelist {
  @ApiProperty()
  @IsString()
  @Expose()
  walletAddress: string;

  constructor(partial: Partial<AcquirerWhitelist>) {
    Object.assign(this, partial);
  }
}

export class AcquirerWhitelistCsv {
  @ApiProperty()
  @IsString()
  @Expose()
  fileName: string;
  @ApiProperty()
  @IsString()
  @Expose()
  fileType: string;
  @ApiProperty()
  @IsString()
  @Expose()
  id: string;
  @ApiProperty()
  @IsString()
  @Expose()
  key: string;
  @ApiProperty()
  @IsString()
  @Expose()
  url: string;
}
