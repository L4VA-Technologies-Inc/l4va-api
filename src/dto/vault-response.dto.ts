export class VaultResponseDto {
  id: string;
  contractAddress: string;
  type: string;
  status: string;
  fractionalizationTokenAddress?: string;
  fractionalizationPercentage?: number;
  tokenSupply?: number;
  tokenDecimals?: number;
  metadata?: string;
  createdAt: Date;
  updatedAt: Date;
}
