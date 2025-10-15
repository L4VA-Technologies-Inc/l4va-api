import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { AssetValueDto } from './asset-value.dto';
import { PaginationMetaDto } from './pagination.dto';

export class WalletOverviewDto {
  @ApiProperty({ description: 'Wallet address' })
  @Expose()
  wallet: string;

  @ApiProperty({ description: 'Total wallet value in ADA' })
  @Expose()
  totalValueAda: number;

  @ApiProperty({ description: 'Total wallet value in USD' })
  @Expose()
  totalValueUsd: number;

  @ApiProperty({ description: 'Last update timestamp' })
  @Expose()
  lastUpdated: string;

  @ApiProperty({ description: 'Wallet summary statistics' })
  @Expose()
  summary: {
    totalAssets: number;
    nfts: number;
    tokens: number;
    ada: number;
  };
}

export class PaginatedWalletSummaryDto {
  @ApiProperty({ description: 'Wallet overview information', type: WalletOverviewDto })
  @Expose()
  overview: WalletOverviewDto;

  @ApiProperty({ description: 'Paginated assets', type: [AssetValueDto] })
  @Expose()
  assets: AssetValueDto[];

  @ApiProperty({ description: 'Pagination metadata', type: PaginationMetaDto })
  @Expose()
  pagination: PaginationMetaDto;
}
