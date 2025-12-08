import { Expose, Type } from 'class-transformer';

import { ClaimStatus } from '@/types/claim.types';

class SimpleVaultDto {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Expose()
  vaultImage: string;

  @Expose({ name: 'vault_token_ticker' })
  vaultTokenTicker: string;

  @Expose({ name: 'ft_token_decimals' })
  ftTokenDecimals: number;
}

export class ClaimResponseDto {
  @Expose()
  page: number;

  @Expose()
  limit: number;

  @Expose()
  total: number;

  @Expose()
  items: ClaimResponseItemsDto[];
}
export class ClaimResponseItemsDto {
  @Expose()
  id: string;

  @Expose()
  type: string;

  @Expose()
  status: ClaimStatus;

  @Expose()
  amount: number;

  @Expose()
  adaAmount: number | null;

  @Expose()
  multiplier: number | null;

  @Expose()
  description: string | null;

  @Expose()
  createdAt: string;

  @Expose()
  updatedAt: string;

  @Expose()
  @Type(() => SimpleVaultDto)
  vault: SimpleVaultDto;
}
