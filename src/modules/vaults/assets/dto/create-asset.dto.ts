import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsEnum, IsNumber, IsOptional, IsObject, ValidateNested } from 'class-validator';

import { AssetType } from '@/types/asset.types';

export class AssetMetadataDto {
  @IsString()
  @ApiProperty()
  name: string;

  @IsString()
  @ApiProperty()
  description: string;

  @IsString()
  @ApiProperty()
  imageUrl: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  category?: string;

  @IsObject()
  @ApiProperty({
    type: 'object',
    description: 'Custom attributes for the asset',
    additionalProperties: true,
    example: {
      rarity: 'legendary',
      edition: '1/100',
      traits: ['gold', 'limited'],
    },
  })
  attributes: Record<string, any>;
}

export class CreateAssetDto {
  @IsString()
  @ApiProperty()
  vaultId: string;

  @IsEnum(AssetType)
  @ApiProperty({ enum: AssetType })
  type: AssetType;

  @IsString()
  @ApiProperty()
  contractAddress: string;

  @IsString()
  @IsOptional()
  @ApiProperty({ required: false })
  tokenId?: string;

  @IsNumber()
  @ApiProperty()
  quantity: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({ required: false })
  floorPrice?: number;

  @IsNumber()
  @IsOptional()
  @ApiProperty({ required: false })
  dexPrice?: number;

  @ValidateNested()
  @Type(() => AssetMetadataDto)
  @ApiProperty({ type: AssetMetadataDto })
  metadata: AssetMetadataDto;
}
