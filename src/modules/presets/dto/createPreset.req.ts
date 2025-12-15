import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { VaultPresetType } from '@/types/vault.types';

export class CreatePresetReq {
  @ApiProperty({ description: 'Preset name', maxLength: 120 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  @Expose()
  name: string;

  @ApiProperty({ description: 'Preset type', enum: VaultPresetType, required: false, default: VaultPresetType.simple })
  @IsOptional()
  @IsEnum(VaultPresetType)
  @Expose()
  type: VaultPresetType = VaultPresetType.custom;

  @ApiProperty({
    description: 'Preset configuration payload',
    required: false,
    type: Object,
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  @Expose()
  config?: Record<string, any>;
}
