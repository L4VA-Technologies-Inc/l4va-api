import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  ProcessTerminationClaimDto,
  ProcessTerminationClaimRes,
  RequestTerminationClaimDto,
  RequestTerminationClaimRes,
  TerminationClaimPreviewRes,
  TerminationStatusRes,
} from './dto/termination-claim.dto';
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
   * Get detailed preview for an existing claim
   */
  @Get('claims/:claimId/preview')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get termination claim preview with dynamic calculation',
  })
  @ApiResponse({
    status: 200,
    description: 'Claim preview',
    type: TerminationClaimPreviewRes,
  })
  async getTerminationClaimPreview(
    @Param('claimId', ParseUUIDPipe) claimId: string
  ): Promise<TerminationClaimPreviewRes> {
    return this.terminationService.getTerminationClaimPreview(claimId);
  }

  /**
   * Request a new termination claim for an address
   * Creates a claim if the address holds VT but wasn't in the original snapshot
   */
  @Post('vaults/:vaultId/claims/request')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Request termination claim for wallet address',
    description:
      'Creates a termination claim for any address holding VT. ' +
      'Useful when VT was transferred to an address not in the original snapshot.',
  })
  @ApiResponse({
    status: 201,
    description: 'Claim created/found',
    type: RequestTerminationClaimRes,
  })
  async requestTerminationClaim(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Body() body: RequestTerminationClaimDto,
    @Req() req: AuthRequest
  ): Promise<RequestTerminationClaimRes> {
    // Use user ID if authenticated, otherwise undefined
    const userId = req.user?.sub;
    return this.terminationService.requestTerminationClaim(vaultId, body.address, userId);
  }

  /**
   * Process (execute) a termination claim
   * User must have sent VT to burn wallet first
   */
  @Post('claims/:claimId/process')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Process termination claim',
    description:
      'Executes a termination claim after user has sent VT to burn wallet. ' +
      'Verifies the VT burn transaction and sends proportional ADA share to user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Claim processed',
    type: ProcessTerminationClaimRes,
  })
  async processTerminationClaim(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() body: ProcessTerminationClaimDto
  ): Promise<ProcessTerminationClaimRes> {
    return this.terminationService.processTerminationClaim(claimId, body.vtBurnTxHash);
  }

  /**
   * Get all termination claims for authenticated user across all vaults
   */
  @Get('my-claims')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get all termination claims for current user' })
  @ApiResponse({ status: 200, description: 'User termination claims' })
  async getMyTerminationClaims(@Req() req: AuthRequest): Promise<{
    claims: Array<{
      claimId: string;
      vaultId: string;
      vaultName: string;
      vtAmount: string;
      adaAmount: string;
      status: string;
      createdAt: Date;
    }>;
  }> {
    return this.terminationService.getUserTerminationClaims(req.user.sub);
  }

  /**
   * Get termination claims for a specific vault and user
   */
  @Get('vaults/:vaultId/my-claims')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Get termination claims for current user in a vault',
  })
  @ApiResponse({
    status: 200,
    description: 'User termination claims for vault',
  })
  async getMyVaultTerminationClaims(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Req() req: AuthRequest
  ): Promise<{
    claims: Array<{
      claimId: string;
      vtAmount: string;
      adaAmount: string;
      status: string;
      canClaim: boolean;
    }>;
  }> {
    return this.terminationService.getUserVaultTerminationClaims(vaultId, req.user.sub);
  }
}
