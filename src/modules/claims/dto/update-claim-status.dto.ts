import { IsEnum } from 'class-validator';

import { ClaimStatus } from '@/types/claim.types';

export class UpdateClaimStatusDto {
  @IsEnum(ClaimStatus)
  status: ClaimStatus;
}
