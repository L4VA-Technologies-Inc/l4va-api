import { Expose } from 'class-transformer';

import { ClaimStatus } from '@/types/claim.types';

export class ClaimResponseDto {
  @Expose()
  id: string;

  @Expose()
  type: string;

  @Expose()
  status: ClaimStatus;

  @Expose()
  amount: number;

  @Expose()
  txHash?: string;

  @Expose()
  description?: string;

  @Expose()
  metadata?: Record<string, any>;

  @Expose()
  createdAt: string;

  @Expose()
  updatedAt: string;
}
