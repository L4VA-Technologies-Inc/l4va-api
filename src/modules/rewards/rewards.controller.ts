import { Body, Controller, Post, Request, UseGuards } from '@nestjs/common';

import { RewardEventProducer } from './services/reward-event-producer.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { RewardActivityType, WidgetSwapEventData, WidgetSwapItemData } from '@/types/rewards.types';

/**
 * Thin rewards controller for l4va-api.
 * Only handles widget-swap event ingestion.
 * All read endpoints (epochs, scores, history) are served by l4va-rewards.
 */
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewardEventProducer: RewardEventProducer) {}

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
}
