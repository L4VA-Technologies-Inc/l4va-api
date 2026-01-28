import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';

import { PaginationDto } from './pagination.dto';

import { SortOrder } from '@/modules/vaults/dto/get-vaults.dto';

export enum VaultActivityFilter {
  ALL = 'all',
  CONTRIBUTE = 'contribute',
  ACQUIRE = 'acquire',
  GOVERNANCE = 'governance',
}

export class GetVaultActivityDto extends PaginationDto {
  @IsEnum(SortOrder)
  @IsOptional()
  @ApiProperty({
    enum: SortOrder,
    required: false,
    default: SortOrder.DESC,
    description: 'Sort order by created_at (ASC or DESC)',
  })
  @Expose()
  sortOrder?: SortOrder = SortOrder.DESC;

  @IsEnum(VaultActivityFilter)
  @IsOptional()
  @ApiProperty({
    enum: VaultActivityFilter,
    required: false,
    default: VaultActivityFilter.ALL,
    description:
      'Filter by activity type: all (transactions + proposals), contribute, acquire, or governance (proposals only)',
  })
  @Expose()
  filter?: VaultActivityFilter = VaultActivityFilter.ALL;

  @IsOptional()
  @ApiProperty({
    required: false,
    default: false,
    description: 'Set true if you want to get all activities',
  })
  isExport?: boolean;
}
