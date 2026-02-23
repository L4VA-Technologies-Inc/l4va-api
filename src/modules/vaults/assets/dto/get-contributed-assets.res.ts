import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class AssetsStatisticsDto {
  @Expose()
  @ApiProperty({ description: 'Total asset value in ADA', example: 1000.5 })
  totalAssetValueAda: number;

  @Expose()
  @ApiProperty({ description: 'Total asset value in USD', example: 500.25 })
  totalAssetValueUsd: number;

  @Expose()
  @ApiProperty({ description: 'Average asset value in ADA', example: 100.05 })
  assetsAvgAda: number;

  @Expose()
  @ApiProperty({ description: 'Average asset value in USD', example: 50.025 })
  assetsAvgUsd: number;

  @Expose()
  @ApiProperty({
    description: 'Total quantity of all contributed assets (sum of quantity per each asset)',
    example: 150,
  })
  totalAssets: number;
}

export class GetContributedAssetsRes {
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
  @Type(() => AssetsStatisticsDto)
  @ApiProperty({ description: 'Asset statistics', type: AssetsStatisticsDto })
  statistics: AssetsStatisticsDto;
}
