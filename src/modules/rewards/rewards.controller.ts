import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';

import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { RewardActivityType, WidgetSwapEventData, WidgetSwapItemData } from '@/types/rewards.types';

/**
 * Thin rewards controller for l4va-api.
 * Handles widget-swap event ingestion + claim operations (proxied to l4va-rewards).
 * All read endpoints (epochs, scores, history) are served by l4va-rewards.
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

  // --- Claim Endpoints (proxied to l4va-rewards) ---

  @UseGuards(AuthGuard)
  @Get('claims')
  async getAvailableClaims(@Request() req: AuthRequest): Promise<any> {
    return this.rewardClaimProxy.getAvailableClaims(req.user.address);
  }

  @UseGuards(AuthGuard)
  @Get('claims/history')
  async getClaimHistory(@Request() req: AuthRequest, @Query('limit') limit = '50'): Promise<any> {
    return this.rewardClaimProxy.getClaimHistory(req.user.address, parseInt(limit, 10));
  }

  @UseGuards(AuthGuard)
  @Post('claim')
  async claimRewards(
    @Request() req: AuthRequest,
    @Body() body: { claimIds?: string[]; transactionId: string }
  ): Promise<any> {
    if (!body.transactionId) {
      return { success: false, error: 'transactionId is required' };
    }
    return this.rewardClaimProxy.markClaimed(req.user.address, body.claimIds ?? [], body.transactionId);
  }

  @UseGuards(AuthGuard)
  @Get('vesting')
  async getVestingPositions(@Request() req: AuthRequest): Promise<any> {
    return this.rewardClaimProxy.getVestingPositions(req.user.address);
  }
}
