import { ApiProperty } from '@nestjs/swagger';

import { AssetValueDto } from './asset-value.dto';
import { PaginationMetaDto } from './pagination.dto';

export class WalletOverviewDto {
  @ApiProperty({ description: 'Wallet address' })
  wallet: string;

  @ApiProperty({ description: 'Total wallet value in ADA' })
  totalValueAda: number;

  @ApiProperty({ description: 'Total wallet value in USD' })
  totalValueUsd: number;

  @ApiProperty({ description: 'Last update timestamp' })
  lastUpdated: string;

  @ApiProperty({ description: 'Wallet summary statistics' })
  summary: {
    totalAssets: number;
    nfts: number;
    tokens: number;
    ada: number;
  };
}

export class PaginatedWalletSummaryDto {
  @ApiProperty({ description: 'Wallet overview information', type: WalletOverviewDto })
  overview: WalletOverviewDto;

  @ApiProperty({ description: 'Paginated assets', type: [AssetValueDto] })
  assets: AssetValueDto[];

  @ApiProperty({ description: 'Pagination metadata', type: PaginationMetaDto })
  pagination: PaginationMetaDto;
}
