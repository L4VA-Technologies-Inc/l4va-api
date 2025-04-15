import { AssetValueDto } from './asset-value.dto';

export class WalletSummaryDto {
  wallet: string;
  assets: AssetValueDto[];
  totalValueAda: number;
  totalValueUsd: number;
  lastUpdated: string;
}
