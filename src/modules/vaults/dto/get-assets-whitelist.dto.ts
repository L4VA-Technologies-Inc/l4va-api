import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

import { PaginationDto } from './pagination.dto';

export class GetAssetsWhitelistDto extends PaginationDto {
  @IsBoolean()
  @IsOptional()
  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Return whitelist entries from my vaults (including drafts)',
  })
  @Expose()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value === 'true';
    }

    return value;
  })
  myVaults?: boolean;

  @IsString()
  @IsOptional()
  @ApiProperty({
    type: String,
    required: false,
    description: 'Search by policy ID or collection name',
  })
  @Expose()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}
