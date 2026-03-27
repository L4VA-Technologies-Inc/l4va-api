import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AssetBuySellDto } from './get-assets.dto';

export class TreasuryWalletAssetBalanceDto {
  @ApiProperty({ example: 'lovelace' })
  unit: string;

  @ApiProperty({ example: '12345' })
  quantity: string;

  @ApiProperty({ example: 'a'.repeat(56) })
  policyId: string;

  @ApiProperty({ example: '4e4654' })
  assetName: string;
}

export class TreasuryWalletBalanceDto {
  @ApiProperty({ description: 'Total lovelace balance', example: 123456789 })
  lovelace: number;

  @ApiProperty({ type: [TreasuryWalletAssetBalanceDto] })
  assets: TreasuryWalletAssetBalanceDto[];
}

export class GetAssetsToListRes {
  @ApiProperty({ type: [AssetBuySellDto] })
  assets: AssetBuySellDto[];

  @ApiPropertyOptional({ type: TreasuryWalletBalanceDto, nullable: true })
  treasuryWalletBalance: TreasuryWalletBalanceDto | null;
}
