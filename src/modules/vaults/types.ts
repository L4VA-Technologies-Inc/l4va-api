import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsUrl } from 'class-validator';

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

export class ContributorWhitelist {
  @ApiProperty()
  @IsString()
  @Expose()
  walletAddress: string;

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
