import { ApiProperty } from '@nestjs/swagger';

export class VaultAssetsSummaryDto {
  @ApiProperty({ description: 'Total value of all assets in ADA' })
  totalValueAda: number;

  @ApiProperty({ description: 'Total value of all assets in USD' })
  totalValueUsd: number;

  @ApiProperty({ description: 'Total acquired ADA' })
  totalAcquiredAda: number;

  @ApiProperty({ description: 'Total acquired USD' })
  totalAcquiredUsd: number;

  @ApiProperty({ description: 'Number of unique assets in the vault' })
  totalAssets: number;

  @ApiProperty({ description: 'Number of NFTs in the vault' })
  nfts: number;

  @ApiProperty({ description: 'Number of fungible tokens in the vault' })
  tokens: number;

  @ApiProperty({ description: 'Timestamp of the last update' })
  lastUpdated: string;

  @ApiProperty({ description: 'Current ADA price in USD' })
  adaPrice: number;
}
