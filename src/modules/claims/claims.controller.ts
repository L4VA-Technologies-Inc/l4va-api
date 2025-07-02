import { Controller, Get, Post, Param, Body, UseGuards, Query, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { AuthGuard } from '../auth/auth.guard';

import { ClaimsService } from './claims.service';
import { ClaimResponseDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';

import { ApiDoc } from '@/decorators/api-doc.decorator';

@ApiTags('Claims')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @ApiDoc({
    summary: 'Get current user claims',
    description: 'Returns claims for current user with optional filtering by status or claim state',
    status: 200,
  })
  @UseGuards(AuthGuard)
  @Get('my')
  @ApiResponse({ type: [ClaimResponseDto] })
  async getMyClaims(@Request() req, @Query() query: GetClaimsDto) {
    const userId = req.user.sub;
    return this.claimsService.getUserClaims(userId, query);
  }

  @UseGuards(AuthGuard)
  @Post(':id/claim')
  @ApiOperation({ summary: 'Process claim and build transaction' })
  async processClaim(@Param('id') id: string) {
    return this.claimsService.buildClaimTransaction(id);
  }

  @Post(':id/claim/submit')
  @UseGuards(AuthGuard)
  async submitSignedClaimTransaction(@Param('id') transactionId: string, @Body() body: { signedTx: string }) {
    return this.claimsService.submitSignedTransaction(transactionId, body.signedTx);
  }

  @Post('webhook/tx-confirmed')
  async webhookTxConfirmed(@Body() body: { txHash: string }) {
    await this.claimsService.processConfirmedTransaction(body.txHash);
    return { received: true };
  }
}
