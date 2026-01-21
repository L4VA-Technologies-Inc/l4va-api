import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

import { ClaimStatus } from '@/types/claim.types';

/**
 * Request DTO for requesting a new termination claim
 */
export class RequestTerminationClaimDto {
  @ApiProperty({ description: 'User wallet address requesting the claim' })
  @IsString()
  @IsNotEmpty()
  address: string;
}

/**
 * Request DTO for processing a termination claim
 */
export class ProcessTerminationClaimDto {
  @ApiProperty({
    description: 'Transaction hash of user sending VT to burn wallet',
  })
  @IsString()
  @IsNotEmpty()
  vtBurnTxHash: string;
}

/**
 * Response DTO for termination claim preview
 */
export class TerminationClaimPreviewRes {
  @ApiProperty({ description: 'Claim ID' })
  claimId: string;

  @ApiProperty({ description: 'Original VT amount from snapshot' })
  originalVtAmount: string;

  @ApiProperty({ description: 'Current on-chain VT balance' })
  currentVtBalance: string;

  @ApiProperty({ description: 'Original ADA share from snapshot' })
  originalAdaShare: string;

  @ApiProperty({ description: 'Current calculated ADA share' })
  currentAdaShare: string;

  @ApiProperty({ description: 'Percentage share of the treasury' })
  sharePercentage: number;

  @ApiProperty({ description: 'Total treasury balance available' })
  treasuryBalance: string;

  @ApiProperty({ description: 'Total circulating VT supply' })
  circulatingSupply: string;

  @ApiProperty({ description: 'Current claim status', enum: ClaimStatus })
  status: ClaimStatus;

  @ApiProperty({ description: 'Whether the user can claim' })
  canClaim: boolean;

  @ApiPropertyOptional({ description: 'Reason if cannot claim' })
  reason?: string;
}

/**
 * Response DTO for requesting a termination claim
 */
export class RequestTerminationClaimRes {
  @ApiProperty({ description: 'Claim ID' })
  claimId: string;

  @ApiProperty({ description: 'VT balance for this claim' })
  vtBalance: string;

  @ApiProperty({ description: 'ADA share for this claim' })
  adaShare: string;

  @ApiProperty({ description: 'Percentage share of the treasury' })
  sharePercentage: number;

  @ApiProperty({ description: 'Whether this is a newly created claim' })
  isNewClaim: boolean;
}

/**
 * Response DTO for processing a termination claim
 */
export class ProcessTerminationClaimRes {
  @ApiProperty({ description: 'ADA distribution transaction hash' })
  adaTxHash: string;

  @ApiProperty({ description: 'Actual VT amount burned' })
  actualVtBurned: string;

  @ApiProperty({ description: 'ADA amount received' })
  adaReceived: string;

  @ApiProperty({ description: 'Final percentage share' })
  sharePercentage: number;
}

/**
 * Response DTO for termination status
 */
export class TerminationStatusRes {
  @ApiProperty({ description: 'Vault ID' })
  vaultId: string;

  @ApiProperty({ description: 'Whether vault is in termination' })
  isTerminating: boolean;

  @ApiPropertyOptional({ description: 'Current termination status' })
  status?: string;

  @ApiPropertyOptional({
    description: 'Proposal ID that initiated termination',
  })
  proposalId?: string;

  @ApiPropertyOptional({ description: 'Total ADA available for distribution' })
  totalAdaForDistribution?: string;

  @ApiPropertyOptional({ description: 'Treasury balance' })
  treasuryBalance?: string;

  @ApiPropertyOptional({ description: 'Circulating VT supply' })
  circulatingSupply?: string;

  @ApiProperty({ description: 'Whether claims are open' })
  claimsOpen: boolean;
}
