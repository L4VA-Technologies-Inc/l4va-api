import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { Type, Transform, Expose } from 'class-transformer';

import { ClaimStatus } from '@/types/claim.types';

export class GetClaimsDto {
  @ApiPropertyOptional({
    enum: ClaimStatus,
    description: 'Filter by specific status',
  })
  @IsOptional()
  @IsEnum(ClaimStatus)
  @Expose()
  status?: ClaimStatus;

  @ApiPropertyOptional({
    enum: ['claimed', 'unclaimed'],
    description:
      'Filter by claim state: "claimed" maps to status CLAIMED, "unclaimed" maps to statuses DISABLED and PENDING',
  })
  @IsOptional()
  @IsString()
  @Expose()
  claimState?: 'claimed' | 'unclaimed';

  @IsOptional()
  page?: string;
  
  @IsOptional()
  limit?: string;
}
