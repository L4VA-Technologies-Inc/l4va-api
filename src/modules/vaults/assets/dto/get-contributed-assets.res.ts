import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

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
}
