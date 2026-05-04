import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';

import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { RewardActivityType, WidgetSwapEventData, WidgetSwapItemData } from '@/types/rewards.types';

/**
 * Public rewards controller for l4va-api.
 * Acts as a BFF (Backend For Frontend) layer:
 * - Handles widget-swap event ingestion
 * - Proxies all read/write operations to internal l4va-rewards service
 * - l4va-rewards returns clean, typed DTOs (no transformation needed)
 *
 * l4va-rewards remains an internal/private service.
 */
@Controller('rewards')
export class RewardsController {
  constructor(
    private readonly rewardEventProducer: RewardEventProducer,
    private readonly rewardClaimProxy: RewardClaimProxy
  ) {}

  /**
   * POST /rewards/widget-swap
   * Called by the frontend DexHunter widget onSuccess callback.
   */
  @UseGuards(AuthGuard)
  @Post('widget-swap')
  async trackWidgetSwap(@Request() req: AuthRequest, @Body() body: WidgetSwapEventData): Promise<any> {
    const swaps: WidgetSwapItemData[] = Array.isArray(body?.data)
      ? body.data
      : body?.tx_hash
        ? [body as WidgetSwapItemData]
        : [];

    const successfulSwap = swaps.find(swap => {
      const status = String(swap?.status ?? '').toLowerCase();
      return !!swap?.tx_hash && (status === 'submitted' || status === 'success');
    });

    if (!successfulSwap) {
      return { indexed: false, reason: 'swap not successful' };
    }

    const event = await this.rewardEventProducer.indexEvent({
      walletAddress: successfulSwap.user_address || req.user.address,
      eventType: RewardActivityType.WIDGET_SWAP,
      txHash: successfulSwap.tx_hash,
      units: 1,
      metadata: {
        dex: successfulSwap.dex,
        tokenIn: successfulSwap.token_id_in,
        tokenOut: successfulSwap.token_id_out,
        amountIn: successfulSwap.amount_in,
        expectedOutput: successfulSwap.expected_output,
        expectedOutputWithoutSlippage: (successfulSwap as any).expected_output_without_slippage,
        poolId: (successfulSwap as any).pool_id,
        type: successfulSwap.type,
      },
    });

    return { indexed: !!event, eventId: event?.id };
  }

  // ============================================================================
  // Epoch Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('epochs')
  async getEpochs(@Query('limit') limit = '20', @Query('offset') offset = '0'): Promise<any> {
    return this.rewardClaimProxy.getEpochs(parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('epochs/current')
  async getCurrentEpoch(): Promise<any> {
    return this.rewardClaimProxy.getCurrentEpoch();
  }

  @Get('epochs/:id')
  async getEpochDetails(@Param('id') id: string): Promise<any> {
    return this.rewardClaimProxy.getEpochById(id);
  }

  // ============================================================================
  // Score & History Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/score')
  async getWalletScore(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletScore(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/alignment')
  async getAlignmentDetails(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getAlignmentDetails(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/history')
  async getWalletHistory(@Request() req: AuthRequest, @Query('limit') limit = '20'): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletHistory(walletAddress, parseInt(limit, 10));
  }

  // ============================================================================
  // Vault Rewards Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('vault/:vaultId/scores')
  async getVaultScores(@Param('vaultId') vaultId: string, @Query('epochId') epochId?: string): Promise<any> {
    return this.rewardClaimProxy.getVaultScores(vaultId, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/vault/:vaultId')
  async getWalletVaultReward(
    @Request() req: AuthRequest,
    @Param('vaultId') vaultId: string,
    @Query('epochId') epochId?: string
  ): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaultReward(walletAddress, vaultId, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/vaults')
  async getWalletVaults(@Request() req: AuthRequest, @Query('epochId') epochId?: string): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaults(walletAddress, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/timeline/vaults')
  async getWalletVaultTimeline(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaultTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/timeline/activities')
  async getWalletActivityTimeline(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletActivityTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/current-estimate')
  async getCurrentEpochEstimate(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getCurrentEpochEstimate(walletAddress);
  }

  // ============================================================================
  // Claims Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/claims')
  async getClaimsSummary(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getAvailableClaims(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/claimable')
  async getClaimableAmount(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getClaimableSummary(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/history')
  async getClaimHistory(@Request() req: AuthRequest, @Query('limit') limit = '50'): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getClaimHistory(walletAddress, parseInt(limit, 10));
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/transactions')
  async getClaimTransactions(@Request() req: AuthRequest, @Query('limit') limit = '50'): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getClaimTransactions(walletAddress, parseInt(limit, 10));
  }

  /**
   * POST /rewards/me/claims/prepare
   * Phase 1 of the witness claim flow.
   * Atomically reserves claims and returns an unsigned tx CBOR that the user
   * must sign via CIP-30 signTx() before calling /me/claims/submit.
   *
   * Returns 409 if a claim is already in progress for this wallet.
   */
  @UseGuards(AuthGuard)
  @Post('me/claims/prepare')
  async prepareClaimTransaction(
    @Request() req: AuthRequest,
    @Body()
    body: {
      epochIds?: string[];
      claimImmediate?: boolean;
      claimVested?: boolean;
    }
  ): Promise<{
    reservationId: string;
    txCbor: string;
    claimableImmediateAmount: number;
    claimableVestedAmount: number;
    totalClaimableAmount: number;
  }> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.prepareClaim(walletAddress, body);
  }

  /**
   * POST /rewards/me/claims/submit
   * Phase 2 of the witness claim flow.
   * Receives the user's CIP-30 witness, assembles the transaction with the
   * treasury key, submits to the blockchain, and confirms the reservation.
   *
   * Call this only after signing txCbor from /me/claims/prepare.
   */
  @UseGuards(AuthGuard)
  @Post('me/claims/submit')
  async submitClaimTransaction(
    @Request() req: AuthRequest,
    @Body() body: { reservationId: string; txCbor: string; userWitness: string }
  ): Promise<{
    success: boolean;
    txHash: string;
    claimedAmount: number;
    claimedImmediateAmount: number;
    claimedVestedAmount: number;
  }> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.submitClaim(walletAddress, body.reservationId, body.txCbor, body.userWitness);
  }

  /**
   * POST /rewards/me/claims/cancel
   * Explicitly releases a PROCESSING reservation when the user declines signing.
   * This is a best-effort call — the reservation will also be cleaned up by the
   * cron job after its TTL expires, but calling this immediately unblocks the user.
   */
  @UseGuards(AuthGuard)
  @Post('me/claims/cancel')
  async cancelClaimTransaction(@Body() body: { reservationId: string }): Promise<{ cancelled: boolean }> {
    await this.rewardClaimProxy.cancelClaim(body.reservationId);
    return { cancelled: true };
  }

  /**
   * @deprecated Use POST /rewards/me/claims/prepare + /me/claims/submit instead.
   * POST /rewards/me/claims/build
   * Build and submit a claim transaction with on-chain L4VA payment.
   * Returns 200 with transaction hash on success.
   * Returns 400 BadRequest on failure (no database changes on failure).
   */
  @UseGuards(AuthGuard)
  @Post('me/claims/build')
  async buildClaimTransaction(
    @Request() req: AuthRequest,
    @Body() body: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean }
  ): Promise<{
    success: boolean;
    txHash: string;
    claimedAmount: number;
    claimedImmediateAmount: number;
    claimedVestedAmount: number;
  }> {
    const walletAddress = req.user.address;
    // Let BadRequestException propagate - NestJS will handle as HTTP 400
    return this.rewardClaimProxy.buildAndExecuteClaim(walletAddress, body);
  }

  // ============================================================================
  // Vesting Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/vesting')
  async getVestingSummary(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getVestingPositions(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/vesting/active')
  async getActiveVesting(@Request() req: AuthRequest): Promise<any> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getActiveVesting(walletAddress);
  }

  // ============================================================================
  // Configuration Endpoints (proxied to l4va-rewards)
  // ============================================================================

  // @Get('weights')
  // async getWeights(): Promise<any> {
  //   return this.rewardClaimProxy.getWeights();
  // }
}
