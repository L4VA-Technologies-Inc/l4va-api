import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

import { ClaimStatus } from '@/types/claim.types';

export class GetClaimsDto {
  @ApiPropertyOptional({
    enum: ClaimStatus,
    description: 'Filter by specific status',
  })
  @IsOptional()
  @IsEnum(ClaimStatus)
  status?: ClaimStatus;

  @ApiPropertyOptional({
    enum: ['claimed', 'unclaimed'],
    description: 'Filter by claim state (claimed=CLAIMED, unclaimed=DISABLED+PENDING)',
  })
  @IsOptional()
  @IsString()
  claimState?: 'claimed' | 'unclaimed';
}
