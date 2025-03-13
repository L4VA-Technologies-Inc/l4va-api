import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaginationDto } from './pagination.dto';

export enum VaultFilter {
  open = 'open',
  locked = 'locked'
}

export class GetVaultsDto extends PaginationDto {
  @IsEnum(VaultFilter)
  @IsOptional()
  @ApiProperty({ enum: VaultFilter, required: false })
  filter?: VaultFilter;
}
