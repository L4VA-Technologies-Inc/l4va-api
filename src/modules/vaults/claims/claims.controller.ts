import { Controller, Get, UseGuards, Query, Request } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';

import { AuthGuard } from '../../auth/auth.guard';
import { AuthRequest } from '../../auth/dto/auth-user.interface';

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
  async getMyClaims(@Request() req: AuthRequest, @Query() query: GetClaimsDto): Promise<ClaimResponseDto> {
    const userId = req.user.sub;
    return this.claimsService.getUserClaims(userId, query);
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
