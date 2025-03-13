import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum VaultFilter {
  open = 'open',
  locked = 'locked'
}

export class GetVaultsDto {
  @IsEnum(VaultFilter)
  @IsOptional()
  @ApiProperty({ enum: VaultFilter, required: false })
  filter?: VaultFilter;
}
