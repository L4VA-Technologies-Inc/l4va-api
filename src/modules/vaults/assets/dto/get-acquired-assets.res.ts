import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class GetAcquiredAssetsRes {
  @Expose()
  @ApiProperty({ description: 'List of assets', type: [Object] })
  items: Record<string, unknown>[];

  @Expose()
  @ApiProperty({ description: 'Total number of assets', example: 100 })
  total: number;

  @Expose()
  @ApiProperty({ description: 'Current page number', example: 1 })
  page: number;

  @Expose()
  @ApiProperty({ description: 'Items per page', example: 10 })
  limit: number;

  @Expose()
  @ApiProperty({ description: 'Total number of pages', example: 10 })
  totalPages: number;

  @Expose()
  @ApiProperty({ description: 'Total acquired quantity (sum of all quantities)', example: 1000.5 })
  totalAcquired: number;

  @Expose()
  @ApiProperty({ description: 'Total acquired value in USD', example: 500.25 })
  totalAcquiredUsd: number;

  @Expose()
  @ApiProperty({ description: 'Total number of unique acquirers', example: 25 })
  totalAcquirers: number;

  @Expose()
  @ApiProperty({
    description: 'Total ADA liquidity across all DEX pools (null if no LP exists)',
    example: 15000.5,
    nullable: true,
  })
  totalAdaLiquidityAda: number;

  @Expose()
  @ApiProperty({
    description: 'Total ADA liquidity converted to USD (null if no LP exists)',
    example: 9750.32,
    nullable: true,
  })
  totalAdaLiquidityUsd: number;
}
