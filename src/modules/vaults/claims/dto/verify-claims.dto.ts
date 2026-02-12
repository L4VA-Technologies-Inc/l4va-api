import { ApiProperty } from '@nestjs/swagger';

import { ClaimType } from '@/types/claim.types';

export class UserClaimBreakdown {
  @ApiProperty()
  userId: string;

  @ApiProperty()
  userAddress?: string;

  @ApiProperty({ description: 'Total VT tokens claimed by this user' })
  totalVtClaimed: number;

  @ApiProperty({ description: 'Total ADA (lovelace) claimed by this user' })
  totalAdaClaimed: number;

  @ApiProperty({ description: 'Number of contribution transactions' })
  contributionTransactions: number;

  @ApiProperty({ description: 'Number of acquisition transactions' })
  acquisitionTransactions: number;

  @ApiProperty({ description: 'Total value contributed in ADA' })
  totalContributed?: number;

  @ApiProperty({ description: 'Total ADA acquired (sent to vault)' })
  totalAcquired?: number;

  @ApiProperty({ description: 'Number of claims with discrepancies' })
  discrepancyCount: number;

  @ApiProperty({ description: 'Largest VT discrepancy for this user' })
  maxVtDiscrepancy?: number;

  @ApiProperty({ description: 'Largest ADA discrepancy for this user' })
  maxAdaDiscrepancy?: number;

  @ApiProperty({ description: 'User share percentage of total TVL' })
  tvlSharePercent?: number;

  @ApiProperty({ description: 'Expected VT based on manual calculation' })
  expectedVtFromTvlShare?: number;

  @ApiProperty({ description: 'Detailed claim breakdown' })
  claims: Array<{
    claimId: string;
    type: ClaimType;
    actualVt: number;
    expectedVt: number;
    actualAda: number;
    expectedAda: number;
    transactionId?: string;
  }>;
}

export class ClaimDiscrepancy {
  @ApiProperty()
  claimId: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  transactionId?: string;

  @ApiProperty({ enum: ClaimType })
  type: ClaimType;

  @ApiProperty({ description: 'Amount stored in database' })
  actualAmount: number;

  @ApiProperty({ description: 'Amount calculated from formulas' })
  expectedAmount: number;

  @ApiProperty({ description: 'Difference between actual and expected' })
  difference: number;

  @ApiProperty({ description: 'Percentage difference' })
  percentageDifference: number;

  @ApiProperty({ description: 'Lovelace amount stored in database' })
  actualLovelaceAmount?: number;

  @ApiProperty({ description: 'Lovelace amount calculated from formulas' })
  expectedLovelaceAmount?: number;

  @ApiProperty({ description: 'Difference in lovelace amounts' })
  lovelaceDifference?: number;

  @ApiProperty({ description: 'Multiplier stored in database' })
  actualMultiplier?: number;

  @ApiProperty({ description: 'Multiplier calculated from formulas' })
  expectedMultiplier?: number;

  @ApiProperty({ description: 'Additional details about the discrepancy' })
  details?: Record<string, any>;
}

export class ClaimVerificationSummary {
  @ApiProperty()
  totalClaims: number;

  @ApiProperty()
  validClaims: number;

  @ApiProperty()
  claimsWithDiscrepancies: number;

  @ApiProperty()
  acquirerClaims: number;

  @ApiProperty()
  contributorClaims: number;

  @ApiProperty()
  lpClaims: number;

  @ApiProperty({ description: 'Total VT distributed according to database' })
  actualTotalVtDistributed: number;

  @ApiProperty({ description: 'Total VT that should be distributed according to calculations' })
  expectedTotalVtDistributed: number;

  @ApiProperty({ description: 'Difference in total VT distribution' })
  vtDistributionDifference: number;

  @ApiProperty({ description: 'Total ADA distributed according to database' })
  actualTotalAdaDistributed: number;

  @ApiProperty({ description: 'Total ADA that should be distributed according to calculations' })
  expectedTotalAdaDistributed: number;

  @ApiProperty({ description: 'Difference in total ADA distribution' })
  adaDistributionDifference: number;

  @ApiProperty({ description: 'Maximum rounding error found in VT amounts' })
  maxVtRoundingError: number;

  @ApiProperty({ description: 'Maximum rounding error found in ADA amounts' })
  maxAdaRoundingError: number;
}

export class VaultCalculationContext {
  @ApiProperty()
  vaultId: string;

  @ApiProperty()
  vaultName: string;

  @ApiProperty()
  vaultStatus: string;

  @ApiProperty()
  totalAcquiredAda: number;

  @ApiProperty()
  totalContributedValueAda: number;

  @ApiProperty()
  vtSupply: number;

  @ApiProperty()
  assetsOfferedPercent: number;

  @ApiProperty()
  lpPercent: number;

  @ApiProperty()
  lpAdaAmount: number;

  @ApiProperty()
  lpVtAmount: number;

  @ApiProperty()
  vtPrice: number;

  @ApiProperty()
  fdv: number;

  @ApiProperty()
  acquisitionTransactions: number;

  @ApiProperty()
  contributionTransactions: number;
}

export class CalculationFormulas {
  @ApiProperty({ description: 'Liquidity Pool calculation formulas' })
  lpCalculation: {
    formula: string;
    steps: string[];
    roundingApplied: string[];
    intermediateValues: Record<string, number>;
  };

  @ApiProperty({ description: 'Acquirer tokens calculation formulas' })
  acquirerCalculation: {
    formula: string;
    steps: string[];
    roundingApplied: string[];
    example?: {
      input: Record<string, number>;
      output: Record<string, number>;
    };
  };

  @ApiProperty({ description: 'Contributor tokens calculation formulas' })
  contributorCalculation: {
    formula: string;
    steps: string[];
    roundingApplied: string[];
    example?: {
      input: Record<string, number>;
      output: Record<string, number>;
    };
  };

  @ApiProperty({ description: 'Rounding methods used' })
  roundingMethods: {
    round25: string;
    mathFloor: string;
    mathRound: string;
  };
}

export class VerifyClaimsResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  message: string;

  @ApiProperty({ type: VaultCalculationContext })
  context: VaultCalculationContext;

  @ApiProperty({ type: CalculationFormulas })
  formulas: CalculationFormulas;

  @ApiProperty({ type: ClaimVerificationSummary })
  summary: ClaimVerificationSummary;

  @ApiProperty({ type: [ClaimDiscrepancy] })
  discrepancies: ClaimDiscrepancy[];

  @ApiProperty({ type: [UserClaimBreakdown], description: 'Per-user breakdown of claims and discrepancies' })
  userBreakdowns: UserClaimBreakdown[];

  @ApiProperty({ description: 'Timestamp when verification was performed' })
  verifiedAt: Date;
}
