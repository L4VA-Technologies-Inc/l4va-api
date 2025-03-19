import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaginationDto } from './pagination.dto';

export enum VaultFilter {
  open = 'open',
  locked = 'locked'
}

export enum VaultSortField {
  name = 'name',
  createdAt = 'created_at',
  updatedAt = 'updated_at'
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC'
}

export class GetVaultsDto extends PaginationDto {
  @IsEnum(VaultFilter)
  @IsOptional()
  @ApiProperty({ enum: VaultFilter, required: false })
  filter?: VaultFilter;

  @IsEnum(VaultSortField)
  @IsOptional()
  @ApiProperty({
    enum: VaultSortField,
    required: false,
    description: 'Field to sort by'
  })
  sortBy?: VaultSortField;

  @IsEnum(SortOrder)
  @IsOptional()
  @ApiProperty({
    enum: SortOrder,
    required: false,
    default: SortOrder.DESC,
    description: 'Sort order (ASC or DESC)'
  })
  sortOrder?: SortOrder = SortOrder.DESC;
}
