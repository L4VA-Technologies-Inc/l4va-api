import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEthereumAddress,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { INDEX_MAX_ASSETS } from '@/types/index-vault.types';

export class IndexBasketItemDto {
  @ApiProperty({
    description: 'ERC-20 address of the basket asset',
    example: '0x0000000000000000000000000000000000000001',
  })
  @IsEthereumAddress()
  @Expose()
  assetAddress: string;

  @ApiProperty({
    description: 'Target weight in basis points (100 = 1%). All weights must sum to 10000.',
    example: 5000,
  })
  @IsInt()
  @Min(1)
  @Max(10000)
  @Expose()
  weightBps: number;

  @ApiProperty({ required: false, description: 'Display symbol; read from the token when omitted' })
  @IsOptional()
  @IsString()
  @Expose()
  symbol?: string;

  @ApiProperty({ required: false, description: 'Display name; read from the token when omitted' })
  @IsOptional()
  @IsString()
  @Expose()
  name?: string;

  @ApiProperty({ required: false, description: 'Logo URL shown in the vault profile' })
  @IsOptional()
  @IsString()
  @Expose()
  image?: string;
}

export class IndexBasketReq {
  @ApiProperty({ type: [IndexBasketItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INDEX_MAX_ASSETS)
  @ValidateNested({ each: true })
  @Type(() => IndexBasketItemDto)
  @Expose()
  targets: IndexBasketItemDto[];

  @ApiProperty({ description: 'Share of NAV kept in native (cash / LP reserve), in bps', example: 1000 })
  @IsInt()
  @Min(0)
  @Max(5000)
  @Expose()
  reserveBps: number;
}
