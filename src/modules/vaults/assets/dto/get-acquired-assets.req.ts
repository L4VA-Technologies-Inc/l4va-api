import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class GetAcquiredAssetsReq {
  @Expose()
  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Search by wallet address',
    example: 'addr1...',
    required: false,
  })
  search?: string;

  @Expose()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ description: 'Page number', example: 1, default: 1, required: false })
  page: number;

  @Expose()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiProperty({ description: 'Items per page', example: 10, default: 10, required: false })
  limit: number;

  @Expose()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @ApiProperty({ description: 'Minimum quantity filter', example: 10, required: false })
  minQuantity?: number;

  @Expose()
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @ApiProperty({ description: 'Maximum quantity filter', example: 100, required: false })
  maxQuantity?: number;
}
