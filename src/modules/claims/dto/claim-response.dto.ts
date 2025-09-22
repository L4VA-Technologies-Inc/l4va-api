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
  id: string;

  @Expose()
  type: string;

  @Expose()
  status: ClaimStatus;

  @Expose()
  amount: string;

  @Expose()
  description: string | null;

  @Expose()
  metadata: Record<string, any> | null;

  @Expose()
  created_at: string;

  @Expose({ name: 'updated_at' })
  updatedAt: string;

  @Expose()
  @Type(() => SimpleVaultDto)
  vault: SimpleVaultDto;
}
