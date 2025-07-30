import { Expose, Type } from 'class-transformer';

import { ClaimStatus } from '@/types/claim.types';

class SimpleVaultDto {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Expose()
  image: string;
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
  tx_hash: string | null;

  @Expose()
  description: string | null;

  @Expose()
  metadata: Record<string, any> | null;

  @Expose()
  created_at: string;

  @Expose()
  updated_at: string;

  @Expose()
  userId: string;

  @Expose()
  @Type(() => SimpleVaultDto)
  vault: SimpleVaultDto;
}
