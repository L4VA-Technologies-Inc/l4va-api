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
  @Get('score/:walletAddress')
  async getWalletScore(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getWalletScore(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('history/:walletAddress')
  async getWalletHistory(@Param('walletAddress') walletAddress: string, @Query('limit') limit = '20'): Promise<any> {
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
  @Get('wallet/:walletAddress/vault/:vaultId')
  async getWalletVaultReward(
    @Param('walletAddress') walletAddress: string,
    @Param('vaultId') vaultId: string,
    @Query('epochId') epochId?: string
  ): Promise<any> {
    return this.rewardClaimProxy.getWalletVaultReward(walletAddress, vaultId, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/vaults')
  async getWalletVaults(
    @Param('walletAddress') walletAddress: string,
    @Query('epochId') epochId?: string
  ): Promise<any> {
    return this.rewardClaimProxy.getWalletVaults(walletAddress, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/timeline/vaults')
  async getWalletVaultTimeline(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getWalletVaultTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/timeline/activities')
  async getWalletActivityTimeline(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getWalletActivityTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/current-estimate')
  async getCurrentEpochEstimate(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getCurrentEpochEstimate(walletAddress);
  }

  // ============================================================================
  // Claims Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress')
  async getClaimsSummary(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getAvailableClaims(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/claimable')
  async getClaimableAmount(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getClaimableSummary(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/history')
  async getClaimHistory(@Param('walletAddress') walletAddress: string, @Query('limit') limit = '50'): Promise<any> {
    return this.rewardClaimProxy.getClaimHistory(walletAddress, parseInt(limit, 10));
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/transactions')
  async getClaimTransactions(
    @Param('walletAddress') walletAddress: string,
    @Query('limit') limit = '50'
  ): Promise<any> {
    return this.rewardClaimProxy.getClaimTransactions(walletAddress, parseInt(limit, 10));
  }

  @UseGuards(AuthGuard)
  @Post('claims/:walletAddress/claim')
  async submitClaim(
    @Param('walletAddress') walletAddress: string,
    @Body() body: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean; transactionId: string }
  ): Promise<any> {
    if (!body.transactionId) {
      return { success: false, error: 'transactionId is required' };
    }
    return this.rewardClaimProxy.executeClaim(walletAddress, body);
  }

  /**
   * POST /rewards/claims/:walletAddress/build
   * Build and submit a claim transaction with on-chain L4VA payment.
   * Returns 200 with transaction hash on success.
   * Returns 400 BadRequest on failure (claims are automatically rolled back).
   */
  @UseGuards(AuthGuard)
  @Post('claims/:walletAddress/build')
  async buildClaimTransaction(
    @Param('walletAddress') walletAddress: string,
    @Body() body: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean }
  ): Promise<{
    success: boolean;
    txHash: string;
    claimedAmount: number;
    claimedImmediateAmount: number;
    claimedVestedAmount: number;
  }> {
    // Let BadRequestException propagate - NestJS will handle as HTTP 400
    return this.rewardClaimProxy.buildAndExecuteClaim(walletAddress, body);
  }

  // ============================================================================
  // Vesting Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('vesting/:walletAddress')
  async getVestingSummary(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getVestingPositions(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('vesting/:walletAddress/active')
  async getActiveVesting(@Param('walletAddress') walletAddress: string): Promise<any> {
    return this.rewardClaimProxy.getActiveVesting(walletAddress);
  }

  // ============================================================================
  // Configuration Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('weights')
  async getWeights(): Promise<any> {
    return this.rewardClaimProxy.getWeights();
  }
}
