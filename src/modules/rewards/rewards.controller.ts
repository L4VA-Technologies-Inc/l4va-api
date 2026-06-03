import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AlignmentDetailsDto,
  CancelClaimResponseDto,
  ClaimHistoryItemDto,
  ClaimsSummaryDto,
  ClaimTransactionDto,
  CurrentEpochEstimateDto,
  CurrentEpochResponseDto,
  EpochDto,
  EpochsResponseDto,
  PrepareClaimResponseDto,
  SubmitClaimResponseDto,
  VaultScoreWithWalletsDto,
  VestingPositionsResponseDto,
  VestingSummaryDto,
  WalletActivityTimelineDto,
  WalletHistoryResponseDto,
  WalletScoreDto,
  WalletVaultDetailsDto,
  WalletVaultTimelineDto,
  WalletVaultsResponseDto,
} from './dto/rewards.dto';
import { RewardClaimProxy } from './services/reward-claim-proxy.service';
import { RewardEventProducer } from './services/reward-event-producer.service';

import { Vault } from '@/database/vault.entity';
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
    private readonly rewardClaimProxy: RewardClaimProxy,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {}

  /**
   * POST /rewards/widget-swap
   * Called by the frontend DexHunter widget onSuccess callback.
   *
   * Only tracks swaps involving Vault Tokens (VT):
   * - Extracts policy IDs from token_id_in/token_id_out
   * - Queries vaults table to match against vault policy_ids
   * - If VT is involved, indexes event with vault_id (vault-scoped)
   * - Non-VT swaps are acknowledged but not indexed
   *
   * This ensures swap rewards are vault-centric and tied to specific vaults.
   */
  @UseGuards(AuthGuard)
  @Post('widget-swap')
  async trackWidgetSwap(
    @Request() req: AuthRequest,
    @Body() body: WidgetSwapEventData
  ): Promise<{
    indexed: boolean;
    reason?: string;
    eventId?: string;
    vaultId?: string;
    vaultName?: string;
  }> {
    const swaps: WidgetSwapItemData[] = Array.isArray(body?.data)
      ? body.data
      : body?.tx_hash
        ? [body as WidgetSwapItemData]
        : [];

    // Find successful swap: if tx_hash exists, the swap was successful
    // Also normalize field names for DexHunter compatibility (token_in/out → token_id_in/out)
    const successfulSwap = swaps.find(swap => {
      return !!swap?.tx_hash;
    });

    if (!successfulSwap) {
      return { indexed: false, reason: 'no transaction hash found' };
    }

    // Normalize DexHunter field names for backward compatibility
    const normalizedSwap = {
      ...successfulSwap,
      token_id_in: successfulSwap.token_id_in || (successfulSwap as any).token_in || '',
      token_id_out: successfulSwap.token_id_out || (successfulSwap as any).token_out || '',
    };

    // Extract policy IDs from token units (first 56 characters)
    const extractPolicyId = (tokenUnit: string): string | null => {
      if (!tokenUnit || tokenUnit === '' || tokenUnit.toLowerCase() === 'lovelace') {
        return null; // ADA has no policy ID
      }
      // Cardano policy IDs are 56 characters (28 bytes hex-encoded)
      return tokenUnit.length >= 56 ? tokenUnit.substring(0, 56) : tokenUnit;
    };

    const policyIdIn = extractPolicyId(normalizedSwap.token_id_in);
    const policyIdOut = extractPolicyId(normalizedSwap.token_id_out);

    // Check if either token is a VT (matches a vault's policy_id)
    const policyIds = [policyIdIn, policyIdOut].filter(Boolean);
    if (policyIds.length === 0) {
      return { indexed: false, reason: 'no vault tokens involved (ADA-only swap)' };
    }

    const vault: Pick<Vault, 'id' | 'script_hash' | 'name'> = await this.vaultRepository.findOne({
      where: policyIds.map(policyId => ({ script_hash: policyId })),
      select: ['id', 'script_hash', 'name'],
    });

    if (!vault) {
      return { indexed: false, reason: 'no vault tokens involved' };
    }

    // Index VT swap event (vault-scoped)
    const event = await this.rewardEventProducer.indexEvent({
      walletAddress: normalizedSwap.user_address || req.user.address,
      vaultId: vault.id,
      eventType: RewardActivityType.WIDGET_SWAP,
      txHash: normalizedSwap.tx_hash,
      units: 1,
      metadata: {
        dex: normalizedSwap.dex,
        tokenIn: normalizedSwap.token_id_in,
        tokenOut: normalizedSwap.token_id_out,
        amountIn: normalizedSwap.amount_in,
        expectedOutput: normalizedSwap.expected_output,
        vaultName: vault.name,
        vaultPolicyId: vault.script_hash,
      },
    });

    return {
      indexed: !!event,
      eventId: event?.id,
      vaultId: vault.id,
      vaultName: vault.name,
    };
  }

  // ============================================================================
  // Epoch Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('epochs')
  async getEpochs(@Query('limit') limit = '20', @Query('offset') offset = '0'): Promise<EpochsResponseDto> {
    return this.rewardClaimProxy.getEpochs(parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('epochs/current')
  async getCurrentEpoch(): Promise<CurrentEpochResponseDto> {
    return this.rewardClaimProxy.getCurrentEpoch();
  }

  @Get('epochs/:id')
  async getEpochDetails(@Param('id') id: string): Promise<EpochDto> {
    return this.rewardClaimProxy.getEpochById(id);
  }

  // ============================================================================
  // Score & History Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/score')
  async getWalletScore(@Request() req: AuthRequest): Promise<WalletScoreDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletScore(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/alignment')
  async getAlignmentDetails(@Request() req: AuthRequest): Promise<AlignmentDetailsDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getAlignmentDetails(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/history')
  async getWalletHistory(@Request() req: AuthRequest, @Query('limit') limit = '20'): Promise<WalletHistoryResponseDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletHistory(walletAddress, parseInt(limit, 10));
  }

  // ============================================================================
  // Vault Rewards Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @Get('vault/:vaultId/scores')
  async getVaultScores(
    @Param('vaultId') vaultId: string,
    @Query('epochId') epochId?: string
  ): Promise<VaultScoreWithWalletsDto> {
    return this.rewardClaimProxy.getVaultScores(vaultId, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/vault/:vaultId')
  async getWalletVaultReward(
    @Request() req: AuthRequest,
    @Param('vaultId') vaultId: string,
    @Query('epochId') epochId?: string
  ): Promise<WalletVaultDetailsDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaultReward(walletAddress, vaultId, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/vaults')
  async getWalletVaults(
    @Request() req: AuthRequest,
    @Query('epochId') epochId?: string
  ): Promise<WalletVaultsResponseDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaults(walletAddress, epochId);
  }

  @UseGuards(AuthGuard)
  @Get('me/timeline/vaults')
  async getWalletVaultTimeline(@Request() req: AuthRequest): Promise<WalletVaultTimelineDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletVaultTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/timeline/activities')
  async getWalletActivityTimeline(@Request() req: AuthRequest): Promise<WalletActivityTimelineDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getWalletActivityTimeline(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/current-estimate')
  async getCurrentEpochEstimate(@Request() req: AuthRequest): Promise<CurrentEpochEstimateDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getCurrentEpochEstimate(walletAddress);
  }

  // ============================================================================
  // Claims Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/claims')
  async getClaimsSummary(@Request() req: AuthRequest): Promise<ClaimsSummaryDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getAvailableClaims(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/claimable')
  async getClaimableAmount(@Request() req: AuthRequest): Promise<ClaimsSummaryDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getClaimableSummary(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/history')
  async getClaimHistory(@Request() req: AuthRequest, @Query('limit') limit = '50'): Promise<ClaimHistoryItemDto[]> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getClaimHistory(walletAddress, parseInt(limit, 10));
  }

  @UseGuards(AuthGuard)
  @Get('me/claims/transactions')
  async getClaimTransactions(
    @Request() req: AuthRequest,
    @Query('limit') limit = '50'
  ): Promise<ClaimTransactionDto[]> {
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
  ): Promise<PrepareClaimResponseDto> {
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
  ): Promise<SubmitClaimResponseDto> {
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
  async cancelClaimTransaction(
    @Request() req: AuthRequest,
    @Body() body: { reservationId: string }
  ): Promise<CancelClaimResponseDto> {
    const result = await this.rewardClaimProxy.cancelClaim(req.user.address, body.reservationId);
    return { cancelled: result.success, message: result.message };
  }

  // ============================================================================
  // Vesting Endpoints (proxied to l4va-rewards)
  // ============================================================================

  @UseGuards(AuthGuard)
  @Get('me/vesting')
  async getVestingSummary(@Request() req: AuthRequest): Promise<VestingSummaryDto> {
    const walletAddress = req.user.address;
    return this.rewardClaimProxy.getVestingPositions(walletAddress);
  }

  @UseGuards(AuthGuard)
  @Get('me/vesting/active')
  async getActiveVesting(@Request() req: AuthRequest): Promise<VestingPositionsResponseDto> {
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
