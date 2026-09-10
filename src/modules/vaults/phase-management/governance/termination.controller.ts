import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SubmitTransactionDto } from '../../processing-tx/onchain/dto/transaction.dto';
import { EvmTerminationService } from '../../processing-tx/onchain/evm-termination.service';

import { TerminationStatusRes } from './dto/termination-claim.dto';
import { TerminationService } from './termination.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { OptionalAuthGuard } from '@/modules/auth/optional-auth.guard';

@ApiTags('Termination')
@Controller('termination')
export class TerminationController {
  constructor(
    private readonly terminationService: TerminationService,
    private readonly evmTerminationService: EvmTerminationService
  ) {}

  /**
   * Live EVM termination state for a vault, read from the contract.
   *
   * `deadline` / `secondsRemaining` are the critical fields: once the claim
   * window closes a holder can no longer redeem, and anything unclaimed is
   * swept to the treasury. Clients must surface that prominently rather than
   * treating it as a detail.
   */
  @Get('vaults/:vaultId/evm')
  @UseGuards(OptionalAuthGuard)
  @ApiOperation({
    summary: 'Get EVM vault termination state',
    description:
      'On-chain redemption rates, per-asset ledger, and the claim deadline. Pass `holder` to include that ' +
      "wallet's current payout preview and any deferred entitlement.",
  })
  @ApiResponse({ status: 200, description: 'EVM termination state' })
  async getEvmTerminationState(
    @Param('vaultId', ParseUUIDPipe) vaultId: string,
    @Query('holder') holder?: string
  ): Promise<unknown> {
    return this.evmTerminationService.getEvmTerminationState(vaultId, holder as `0x${string}` | undefined);
  }

  // ---------------------------------------------------------------------------
  // EVM termination operator escape hatches (service-to-service admin only).
  //
  // These exist because `redeem()` pays every committed asset atomically: if
  // one distributed ERC-20 starts reverting on transfer (issuer pause, the
  // vault blacklisted), every holder's redemption reverts until an operator
  // calls `deferTerminationAsset`. `retryTermination` resumes a commit that
  // stalled in `TerminationPreparing`. All are guarded by AdminGuard (the
  // ADMIN_SERVICE_TOKEN bearer) and re-checked on-chain by the service.
  // ---------------------------------------------------------------------------

  // @Post('vaults/:vaultId/evm/retry')
  // @HttpCode(200)
  // @UseGuards(AdminGuard)
  // @ApiOperation({
  //   summary: '[admin] Resume a stalled EVM termination',
  //   description:
  //     'Re-attempts `beginTermination` for a vault stuck in on-chain TerminationPreparing (step 1 succeeded, ' +
  //     'the rate commit failed). No-ops unless the vault is actually in that state.',
  // })
  // @ApiResponse({ status: 200, description: 'Retry attempted; body reports success' })
  // async retryEvmTermination(
  //   @Param('vaultId', ParseUUIDPipe) vaultId: string,
  //   @Body() body: EvmRetryTerminationDto
  // ): Promise<{ success: boolean }> {
  //   const success = await this.evmGovernanceExecutionService.retryTermination(
  //     vaultId,
  //     body.waived as Address[] | undefined
  //   );
  //   return { success };
  // }

  // @Post('vaults/:vaultId/evm/assets/defer')
  // @HttpCode(200)
  // @UseGuards(AdminGuard)
  // @ApiOperation({
  //   summary: '[admin] Defer a broken termination asset',
  //   description:
  //     'Stops `redeem()` from paying an asset that has broken for everyone (global pause, vault blacklisted, ' +
  //     'always-reverting transfer). Entitlements keep accruing at the committed rate and stay claimable via ' +
  //     '`claimDeferred` once the asset is resumed. Use this the moment redemptions start reverting.',
  // })
  // @ApiResponse({ status: 200, description: 'Defer transaction broadcast' })
  // async deferEvmTerminationAsset(
  //   @Param('vaultId', ParseUUIDPipe) vaultId: string,
  //   @Body() body: EvmTerminationAssetDto
  // ): Promise<{ txHash: string }> {
  //   return this.evmTerminationService.deferTerminationAsset(vaultId, body.asset as Address);
  // }

  // @Post('vaults/:vaultId/evm/assets/resume')
  // @HttpCode(200)
  // @UseGuards(AdminGuard)
  // @ApiOperation({
  //   summary: '[admin] Resume a previously deferred termination asset',
  //   description: 'Re-enables `redeem()` payouts for an asset once its transfer path is healthy again.',
  // })
  // @ApiResponse({ status: 200, description: 'Resume transaction broadcast' })
  // async resumeEvmTerminationAsset(
  //   @Param('vaultId', ParseUUIDPipe) vaultId: string,
  //   @Body() body: EvmTerminationAssetDto
  // ): Promise<{ txHash: string }> {
  //   return this.evmTerminationService.resumeTerminationAsset(vaultId, body.asset as Address);
  // }

  // @Post('vaults/:vaultId/evm/redeem-for')
  // @HttpCode(200)
  // @UseGuards(AdminGuard)
  // @ApiOperation({
  //   summary: '[admin] Push a redemption for an inactive holder',
  //   description:
  //     "Burns the holder's entire VT balance and pays their share strictly to that address. The contract " +
  //     'forbids a recipient override here, so this cannot be used to grief a contract wallet.',
  // })
  // @ApiResponse({ status: 200, description: 'redeemFor transaction broadcast' })
  // async redeemForHolder(
  //   @Param('vaultId', ParseUUIDPipe) vaultId: string,
  //   @Body() body: EvmRedeemForDto
  // ): Promise<{ txHash: string }> {
  //   return this.evmTerminationService.redeemFor(vaultId, body.holder as Address);
  // }

  // @Post('vaults/:vaultId/evm/assets/sweep')
  // @HttpCode(200)
  // @UseGuards(AdminGuard)
  // @ApiOperation({
  //   summary: '[admin] Sweep an unclaimed termination asset to the treasury',
  //   description:
  //     'Manual trigger for `sweepTerminationRemainder`. Normally the lifecycle cron does this automatically once ' +
  //     'the claim window closes; the contract rejects a sweep before `terminationDeadline`.',
  // })
  // @ApiResponse({ status: 200, description: 'Sweep transaction broadcast' })
  // async sweepEvmTerminationAsset(
  //   @Param('vaultId', ParseUUIDPipe) vaultId: string,
  //   @Body() body: EvmTerminationAssetDto
  // ): Promise<{ txHash: string }> {
  //   return this.evmTerminationService.sweepTerminationRemainder(vaultId, body.asset as Address);
  // }

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
