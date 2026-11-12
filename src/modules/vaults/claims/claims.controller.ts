import { Controller, Get, UseGuards, Query, Request, Param, Res, Header } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { Response } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { AuthRequest } from '../../auth/dto/auth-user.interface';

import { ClaimsVerificationService } from './claims-verification.service';
import { ClaimsService } from './claims.service';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';
import { VerifyClaimsQueryDto } from './dto/verify-claims-query.dto';
import { VerifyClaimsResponseDto } from './dto/verify-claims.dto';

import { ApiDoc } from '@/decorators/api-doc.decorator';
import { AdminGuard } from '@/modules/auth/admin.guard';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly claimsVerificationService: ClaimsVerificationService
  ) {}

  @ApiDoc({
    summary: 'Get current user claims',
    description: 'Returns claims for current user with optional filtering by status or claim state',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  @ApiResponse({ type: [ClaimResponseDto] })
  async getMyClaims(@Request() req: AuthRequest, @Query() query: GetClaimsDto): Promise<ClaimResponseDto> {
    const userId = req.user.sub;
    return this.claimsService.getUserClaims(userId, query);
  }

  // C-3: the legacy /claims/l4va/* routes were removed. They handed out admin-signed payouts
  // without reserving the claim (replayable until the admin wallet is empty). L4VA claims go
  // through the rewards-proxy flow only.

  @ApiDoc({
    summary: 'Verify vault claims calculations',
    description:
      'Recalculates all claims for a vault from transactions and compares with database to show rounding differences and discrepancies',
    status: 200,
  })
  @UseGuards(AdminGuard)
  @Get('verify/:vaultId')
  @ApiResponse({ type: VerifyClaimsResponseDto })
  async verifyClaims(
    @Param('vaultId') vaultId: string,
    @Query() query: VerifyClaimsQueryDto
  ): Promise<VerifyClaimsResponseDto> {
    return this.claimsVerificationService.verifyClaims(vaultId, query);
  }

  @ApiDoc({
    summary: 'Export vault claims verification as CSV',
    description: 'Exports per-user claim breakdowns and discrepancies as a CSV file for spreadsheet analysis',
    status: 200,
  })
  @UseGuards(AdminGuard)
  @Get('verify/:vaultId/export/csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="vault-claims-verification.csv"')
  async exportVerificationCsv(
    @Param('vaultId') vaultId: string,
    @Query() query: VerifyClaimsQueryDto,
    @Res() res: Response
  ): Promise<void> {
    const verification = await this.claimsVerificationService.verifyClaims(vaultId, query);

    // Build CSV header
    const csvRows: string[] = [
      [
        'User ID',
        'User Address',
        'Total VT Claimed',
        'Total ADA Claimed (lovelace)',
        'TVL Contributed (ADA)',
        'ADA Acquired',
        'TVL Share %',
        'Expected VT (Simple)',
        'Actual VT',
        'VT Difference',
        'Contribution Txs',
        'Acquisition Txs',
        'Discrepancy Count',
        'Max VT Discrepancy',
        'Max ADA Discrepancy',
      ].join(','),
    ];

    // Add user rows
    for (const user of verification.userBreakdowns) {
      csvRows.push(
        [
          user.userId,
          user.userAddress || 'N/A',
          user.totalVtClaimed,
          user.totalAdaClaimed,
          user.totalContributed || 0,
          user.totalAcquired || 0,
          user.tvlSharePercent?.toFixed(4) || 'N/A',
          user.expectedVtFromTvlShare || 'N/A',
          user.totalVtClaimed,
          user.expectedVtFromTvlShare ? user.totalVtClaimed - user.expectedVtFromTvlShare : 'N/A',
          user.contributionTransactions,
          user.acquisitionTransactions,
          user.discrepancyCount,
          user.maxVtDiscrepancy,
          user.maxAdaDiscrepancy,
        ].join(',')
      );
    }

    // Add summary section
    csvRows.push(''); // Empty line
    csvRows.push('SUMMARY');
    csvRows.push(`Total Claims,${verification.summary.totalClaims}`);
    csvRows.push(`Valid Claims,${verification.summary.validClaims}`);
    csvRows.push(`Claims with Discrepancies,${verification.summary.claimsWithDiscrepancies}`);
    csvRows.push(`Total VT Distributed (Actual),${verification.summary.actualTotalVtDistributed}`);
    csvRows.push(`Total VT Distributed (Expected),${verification.summary.expectedTotalVtDistributed}`);
    csvRows.push(`VT Distribution Difference,${verification.summary.vtDistributionDifference}`);
    csvRows.push(`Total ADA Distributed (Actual),${verification.summary.actualTotalAdaDistributed}`);
    csvRows.push(`Total ADA Distributed (Expected),${verification.summary.expectedTotalAdaDistributed}`);
    csvRows.push(`ADA Distribution Difference,${verification.summary.adaDistributionDifference}`);

    // Add vault context section
    csvRows.push(''); // Empty line
    csvRows.push('VAULT CONTEXT');
    csvRows.push(`Vault ID,${verification.context.vaultId}`);
    csvRows.push(`Vault Name,${verification.context.vaultName}`);
    csvRows.push(`VT Supply,${verification.context.vtSupply}`);
    csvRows.push(`Total Acquired ADA,${verification.context.totalAcquiredAda}`);
    csvRows.push(`Total Contributed Value ADA,${verification.context.totalContributedValueAda}`);
    csvRows.push(`Assets Offered %,${verification.context.assetsOfferedPercent * 100}`);
    csvRows.push(`LP %,${verification.context.lpPercent * 100}`);
    csvRows.push(`VT Price,${verification.context.vtPrice}`);
    csvRows.push(`FDV,${verification.context.fdv}`);

    const csv = csvRows.join('\n');
    res.send(csv);
  }

  // @UseGuards(AuthGuard)
  // @Post(':claimId/build')
  // @ApiOperation({ summary: 'Process claim and build transaction' })
  // async processClaim(@Param('claimId') claimId: string): Promise<{
  //   success: boolean;
  //   transactionId: string;
  //   presignedTx: string;
  // }> {
  //   return this.claimsService.buildClaimTransaction(claimId);
  // }
}
