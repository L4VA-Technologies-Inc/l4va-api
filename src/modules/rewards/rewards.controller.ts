import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';

import { ActivityEventService } from './services/activity-event.service';
import { EpochService } from './services/epoch.service';
import { ScoringService } from './services/scoring.service';

import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { RewardActivityType, WidgetSwapEventData } from '@/types/rewards.types';

@Controller('rewards')
export class RewardsController {
  constructor(
    private readonly epochService: EpochService,
    private readonly scoringService: ScoringService,
    private readonly activityEventService: ActivityEventService
  ) {}

  @Get('epochs')
  async listEpochs(@Query('limit') limit = '20', @Query('offset') offset = '0'): Promise<any> {
    return this.epochService.listEpochs(parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('epochs/current')
  async getCurrentEpoch(): Promise<any> {
    const epoch = await this.epochService.getCurrentEpoch();
    if (!epoch) return { epoch: null, message: 'No active epoch' };
    const summary = await this.activityEventService.getEpochEventSummary(epoch.id);
    return { epoch, eventSummary: summary };
  }

  @Get('epochs/:id')
  async getEpoch(@Param('id') id: string): Promise<any> {
    return this.epochService.getEpochById(id);
  }

  @UseGuards(AuthGuard)
  @Get('my-score')
  async getMyCurrentScore(@Request() req: AuthRequest): Promise<any> {
    return this.scoringService.getWalletCurrentScore(req.user.address);
  }

  @UseGuards(AuthGuard)
  @Get('my-history')
  async getMyScoreHistory(
    @Request() req: AuthRequest,
    @Query('limit') limit = '20',
    @Query('offset') offset = '0'
  ): Promise<any> {
    return this.scoringService.getWalletScoreHistory(req.user.address, parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('weights')
  async getWeights(): Promise<Record<string, number>> {
    const weights = await this.activityEventService.getAllWeights();
    return Object.fromEntries(weights);
  }

  /**
   * POST /rewards/widget-swap
   * Called by the frontend DexHunter widget onSuccess callback.
   */
  @UseGuards(AuthGuard)
  @Post('widget-swap')
  async trackWidgetSwap(@Request() req: AuthRequest, @Body() body: WidgetSwapEventData): Promise<any> {
    if (body.status !== 'success') {
      return { indexed: false, reason: 'swap not successful' };
    }

    const event = await this.activityEventService.indexEvent({
      walletAddress: body.user_address || req.user.address,
      eventType: RewardActivityType.WIDGET_SWAP,
      txHash: body.tx_hash,
      units: 1,
      metadata: {
        dex: body.dex,
        tokenIn: body.token_id_in,
        tokenOut: body.token_id_out,
        amountIn: body.amount_in,
        expectedOutput: body.expected_output,
      },
    });

    return { indexed: !!event, eventId: event?.id };
  }

  // --- Admin Endpoints ---

  @UseGuards(AdminGuard)
  @Post('admin/bootstrap')
  async bootstrapEpoch(): Promise<any> {
    return this.epochService.bootstrapFirstEpoch();
  }

  @UseGuards(AdminGuard)
  @Post('admin/process-epoch')
  async processCurrentEpoch(): Promise<any> {
    const epoch = await this.epochService.getCurrentEpoch();
    if (!epoch) return { error: 'No active epoch' };
    await this.scoringService.processEpochEnd(epoch);
    return { success: true, epochNumber: epoch.epoch_number };
  }
}
