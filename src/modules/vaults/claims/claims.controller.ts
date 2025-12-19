import { Controller, Get, Post, UseGuards, Query, Request, Body, Param } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AuthGuard } from '../../auth/auth.guard';
import { AuthRequest } from '../../auth/dto/auth-user.interface';

import { ClaimsService } from './claims.service';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';
import { L4vaRewardsService } from './l4va-rewards.service';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly l4vaRewardsService: L4vaRewardsService
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

  @ApiDoc({
    summary: 'Build L4VA claim transaction',
    description: 'Build transaction for claiming specific L4VA rewards',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('l4va/build')
  async buildL4VAClaim(
    @Request() req: AuthRequest,
    @Body() body: { claimIds: string[] }
  ): Promise<{
    transactionId: string;
    presignedTx: string;
    totalL4VA: number;
    claimsCount: number;
  }> {
    const userId = req.user.sub;
    const result = await this.l4vaRewardsService.buildBatchL4VAClaimTransaction(userId, body.claimIds);

    return {
      transactionId: result.transactionId,
      presignedTx: result.presignedTx,
      totalL4VA: result.totalL4VAClaimed,
      claimsCount: result.claimedCount,
    };
  }

  @ApiDoc({
    summary: 'Submit signed L4VA claim transaction',
    description: 'Submit a signed L4VA claim transaction to the blockchain',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('l4va/:transactionId/submit')
  async submitL4VAClaim(
    @Param('transactionId') transactionId: string,
    @Body() body: { claimIds: string[]; signedTx: string }
  ): Promise<{
    success: boolean;
    txHash: string;
  }> {
    const result = await this.l4vaRewardsService.submitSignedTransaction(transactionId, body.claimIds, body.signedTx);

    return {
      success: result.success,
      txHash: result.blockchainTxHash,
    };
  }

  @ApiDoc({
    summary: 'Claim all available L4VA rewards',
    description: 'Build transaction to claim all available L4VA rewards for current user',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Post('l4va/claim-all')
  async claimAllL4VA(@Request() req: AuthRequest): Promise<{
    transactionId: string;
    presignedTx: string;
    totalL4VAClaimed: number;
    claimedCount: number;
  }> {
    const userId = req.user.sub;
    return this.l4vaRewardsService.claimAllAvailableL4VA(userId);
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
