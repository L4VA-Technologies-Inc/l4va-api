import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SubmitTransactionDto } from '../../processing-tx/onchain/dto/transaction.dto';

import { TerminationStatusRes } from './dto/termination-claim.dto';
import { TerminationService } from './termination.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

@ApiTags('Termination')
@Controller('termination')
export class TerminationController {
  constructor(private readonly terminationService: TerminationService) {}

  /**
   * Get termination status for a vault
   */
  @Get('vaults/:vaultId/status')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({ summary: 'Get vault termination status' })
  @ApiResponse({
    status: 200,
    description: 'Termination status',
    type: TerminationStatusRes,
  })
  async getTerminationStatus(@Param('vaultId', ParseUUIDPipe) vaultId: string): Promise<TerminationStatusRes> {
    return this.terminationService.getTerminationStatus(vaultId);
  }

  /**
   * Build termination claim transaction (send VT to admin wallet)
   */
  @Post('claims/:claimId/build')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Build termination claim transaction',
    description: 'Builds a transaction for user to send their VT tokens to admin wallet for termination claim',
  })
  @ApiResponse({ status: 200, description: 'Transaction built successfully' })
  async buildTerminationClaim(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Req() req: AuthRequest
  ): Promise<{ transactionId: string; presignedTx: string }> {
    return this.terminationService.buildTerminationClaimTransaction(claimId, req.user.sub);
  }

  /**
   * Submit signed termination claim transaction
   */
  @Post('claims/:transactionId/submit')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Submit signed termination claim transaction',
    description: 'Submits the signed transaction and processes the termination claim distribution',
  })
  @ApiResponse({ status: 200, description: 'Transaction submitted successfully' })
  async submitTerminationClaim(
    @Param('transactionId') transactionId: string,
    @Body() params: SubmitTransactionDto
  ): Promise<{
    success: boolean;
    vtTxHash: string;
    distributionTxHash: string;
    adaReceived: string;
    ftsReceived?: Array<{ policyId: string; assetId: string; quantity: string; name?: string }>;
  }> {
    return this.terminationService.submitTerminationClaimTransaction(params);
  }
}
