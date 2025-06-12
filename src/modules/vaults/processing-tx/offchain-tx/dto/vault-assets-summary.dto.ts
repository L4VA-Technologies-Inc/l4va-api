import { ApiProperty } from '@nestjs/swagger';

export class VaultAssetsSummaryDto {
  @ApiProperty({ description: 'Total value of all assets in ADA' })
  totalValueAda: number;

  @ApiProperty({ description: 'Total value of all assets in USD' })
  totalValueUsd: number;

  @ApiProperty({ description: 'Number of unique assets in the vault' })
  totalAssets: number;

  @ApiProperty({ description: 'Number of NFTs in the vault' })
  nfts: number;

  @ApiProperty({ description: 'Number of fungible tokens in the vault' })
  tokens: number;

  @ApiProperty({ description: 'Timestamp of the last update' })
  lastUpdated: string;

  @ApiProperty({
    description: 'List of assets with their values',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        policyId: { type: 'string' },
        assetName: { type: 'string' },
        quantity: { type: 'number' },
        valueAda: { type: 'number' },
        valueUsd: { type: 'number' },
        isNft: { type: 'boolean' },
        metadata: { type: 'object' },
      },
    },
  })
  assets: Array<{
    policyId: string;
    assetName: string;
    quantity: number;
    valueAda: number;
    valueUsd: number;
    isNft: boolean;
    metadata?: Record<string, any>;
  }>;
}
