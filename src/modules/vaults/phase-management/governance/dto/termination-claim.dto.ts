import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

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
