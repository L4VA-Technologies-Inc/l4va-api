import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';

import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';
import { RewardsTransformerService } from './services/rewards-transformer.service';

import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { RewardActivityType, WidgetSwapEventData, WidgetSwapItemData } from '@/types/rewards.types';

/**
 * Public rewards controller for l4va-api.
 * Acts as a BFF (Backend For Frontend) layer:
 * - Handles widget-swap event ingestion
 * - Proxies all read/write operations to internal l4va-rewards service
 * - Transforms raw data into UI-ready responses with computed properties
 *
 * l4va-rewards remains an internal/private service.
 */
@Controller('rewards')
export class RewardsController {
  constructor(
    private readonly rewardEventProducer: RewardEventProducer,
    private readonly rewardClaimProxy: RewardClaimProxy,
    private readonly transformer: RewardsTransformerService
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
    const data = await this.rewardClaimProxy.getEpochs(parseInt(limit, 10), parseInt(offset, 10));
    return this.transformer.transformEpochs(data);
  }

  @Get('epochs/current')
  async getCurrentEpoch(): Promise<any> {
    const data = await this.rewardClaimProxy.getCurrentEpoch();
    return this.transformer.transformCurrentEpoch(data);
  }

  @Get('epochs/:id')
  async getEpochDetails(@Param('id') id: string): Promise<any> {
    const data = await this.rewardClaimProxy.getEpochById(id);
    return this.transformer.transformEpoch(data);
  }

  // ============================================================================
  // Score & History Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('score/:walletAddress')
  async getWalletScore(@Param('walletAddress') walletAddress: string): Promise<any> {
    const data = await this.rewardClaimProxy.getWalletScore(walletAddress);
    return this.transformer.transformWalletScore(data);
  }

  @UseGuards(AuthGuard)
  @Get('history/:walletAddress')
  async getWalletHistory(@Param('walletAddress') walletAddress: string, @Query('limit') limit = '20'): Promise<any> {
    const data = await this.rewardClaimProxy.getWalletHistory(walletAddress, parseInt(limit, 10));
    return this.transformer.transformWalletHistory(data);
  }

  // ============================================================================
  // Vault Rewards Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('vault/:vaultId/scores')
  async getVaultScores(@Param('vaultId') vaultId: string, @Query('epochId') epochId?: string): Promise<any> {
    const data = await this.rewardClaimProxy.getVaultScores(vaultId, epochId);
    return this.transformer.transformVaultScores(data);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/vault/:vaultId')
  async getWalletVaultReward(
    @Param('walletAddress') walletAddress: string,
    @Param('vaultId') vaultId: string,
    @Query('epochId') epochId?: string
  ): Promise<any> {
    const data = await this.rewardClaimProxy.getWalletVaultReward(walletAddress, vaultId, epochId);
    return this.transformer.transformWalletVaultReward(data);
  }

  @UseGuards(AuthGuard)
  @Get('wallet/:walletAddress/vaults')
  async getWalletVaults(
    @Param('walletAddress') walletAddress: string,
    @Query('epochId') epochId?: string
  ): Promise<any> {
    const data = await this.rewardClaimProxy.getWalletVaults(walletAddress, epochId);
    return this.transformer.transformWalletVaults(data);
  }

  // ============================================================================
  // Claims Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress')
  async getClaimsSummary(@Param('walletAddress') walletAddress: string): Promise<any> {
    const data = await this.rewardClaimProxy.getAvailableClaims(walletAddress);
    return this.transformer.transformClaimsSummary(data);
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/claimable')
  async getClaimableAmount(@Param('walletAddress') walletAddress: string): Promise<any> {
    const data = await this.rewardClaimProxy.getClaimableSummary(walletAddress);
    return this.transformer.transformClaimsSummary(data);
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/history')
  async getClaimHistory(@Param('walletAddress') walletAddress: string, @Query('limit') limit = '50'): Promise<any> {
    const data = await this.rewardClaimProxy.getClaimHistory(walletAddress, parseInt(limit, 10));
    return this.transformer.transformClaimHistory(data);
  }

  @UseGuards(AuthGuard)
  @Get('claims/:walletAddress/transactions')
  async getClaimTransactions(
    @Param('walletAddress') walletAddress: string,
    @Query('limit') limit = '50'
  ): Promise<any> {
    const data = await this.rewardClaimProxy.getClaimTransactions(walletAddress, parseInt(limit, 10));
    return this.transformer.transformClaimTransactions(data);
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

  /**
   * POST /rewards/claims/submit
   * Submit a signed claim transaction to the blockchain.
   * Note: The transaction is already signed by the treasury in the build step.
   */
  @UseGuards(AuthGuard)
  @Post('claims/submit')
  async submitClaimTransaction(@Body() body: { txCbor: string }): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
  }> {
    if (!body.txCbor) {
      return { success: false, error: 'txCbor is required' };
    }
    return this.rewardClaimProxy.submitClaimTransaction(body.txCbor);
  }

  // ============================================================================
  // Vesting Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('vesting/:walletAddress')
  async getVestingSummary(@Param('walletAddress') walletAddress: string): Promise<any> {
    const data = await this.rewardClaimProxy.getVestingPositions(walletAddress);
    return this.transformer.transformVestingSummary(data);
  }

  @UseGuards(AuthGuard)
  @Get('vesting/:walletAddress/active')
  async getActiveVesting(@Param('walletAddress') walletAddress: string): Promise<any> {
    const data = await this.rewardClaimProxy.getActiveVesting(walletAddress);
    return this.transformer.transformVestingPositions(data);
  }

  // ============================================================================
  // Configuration Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('weights')
  async getWeights(): Promise<any> {
    return this.rewardClaimProxy.getWeights();
  }

  // ============================================================================
  // Legacy Endpoints (deprecated, kept for backward compatibility)
  // ============================================================================

  /**
   * @deprecated Use GET /claims/:walletAddress instead
   */
  @UseGuards(AuthGuard)
  @Get('claims')
  async getAvailableClaims(@Request() req: AuthRequest): Promise<any> {
    const data = await this.rewardClaimProxy.getAvailableClaims(req.user.address);
    return this.transformer.transformClaimsSummary(data);
  }

  /**
   * @deprecated Use GET /claims/:walletAddress/history instead
   */
  @UseGuards(AuthGuard)
  @Get('claims/history')
  async getClaimHistoryLegacy(@Request() req: AuthRequest, @Query('limit') limit = '50'): Promise<any> {
    const data = await this.rewardClaimProxy.getClaimHistory(req.user.address, parseInt(limit, 10));
    return this.transformer.transformClaimHistory(data);
  }

  /**
   * @deprecated Use POST /claims/:walletAddress/claim instead
   */
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

  /**
   * @deprecated Use GET /vesting/:walletAddress instead
   */
  @UseGuards(AuthGuard)
  @Get('vesting')
  async getVestingPositions(@Request() req: AuthRequest): Promise<any> {
    const data = await this.rewardClaimProxy.getVestingPositions(req.user.address);
    return this.transformer.transformVestingSummary(data);
  }
}
