import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import {
  AlignmentDetailsDto,
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
} from '../dto/rewards.dto';

/**
 * Internal proxy client for l4va-rewards service.
 * Used by l4va-api to fetch rewards data from the internal rewards service.
 * Acts as a thin adapter layer - l4va-rewards remains private/internal.
 */
@Injectable()
export class RewardClaimProxy {
  private readonly logger = new Logger(RewardClaimProxy.name);
  private readonly rewardsBaseUrl: string;
  private readonly l4vaDecimals: number;
  private readonly internalToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    // Default to local dev setup (localhost:4000)
    // Testnet/Mainnet MUST set REWARDS_SERVICE_URL explicitly (e.g., http://l4va-rewards:3001 for Docker)
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:4000');
    this.l4vaDecimals = this.configService.get<number>('L4VA_DECIMALS') || 3;
    this.internalToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN') || '';
  }

  // ============================================================================
  // Epoch Methods
  // ============================================================================

  async getEpochs(limit = 20, offset = 0): Promise<EpochsResponseDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs?limit=${limit}&offset=${offset}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getCurrentEpoch(): Promise<CurrentEpochResponseDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/current`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getEpochById(epochId: string): Promise<EpochDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/${epochId}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Score & History Methods
  // ============================================================================

  async getWalletScore(walletAddress: string): Promise<WalletScoreDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/score/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getAlignmentDetails(walletAddress: string): Promise<AlignmentDetailsDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/alignment/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletHistory(walletAddress: string, limit = 20): Promise<WalletHistoryResponseDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/history/${walletAddress}?limit=${limit}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Vault Rewards Methods
  // ============================================================================

  async getVaultScores(vaultId: string, epochId?: string): Promise<VaultScoreWithWalletsDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vault/${vaultId}/scores${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaultReward(walletAddress: string, vaultId: string, epochId?: string): Promise<WalletVaultDetailsDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vault/${vaultId}${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaults(walletAddress: string, epochId?: string): Promise<WalletVaultsResponseDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vaults${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaultTimeline(walletAddress: string): Promise<WalletVaultTimelineDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/vaults`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletActivityTimeline(walletAddress: string): Promise<WalletActivityTimelineDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/activities`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getCurrentEpochEstimate(walletAddress: string): Promise<CurrentEpochEstimateDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/current-estimate`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Claims Methods
  // ============================================================================

  async getAvailableClaims(walletAddress: string): Promise<ClaimsSummaryDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimableSummary(walletAddress: string): Promise<ClaimsSummaryDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/claimable`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimHistory(walletAddress: string, limit = 50): Promise<ClaimHistoryItemDto[]> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/history?limit=${limit}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimTransactions(walletAddress: string, limit = 50): Promise<ClaimTransactionDto[]> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/transactions?limit=${limit}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async executeClaim(
    walletAddress: string,
    payload: {
      epochIds?: string[];
      claimImmediate?: boolean;
      claimVested?: boolean;
      txHash: string;
      claimedImmediateAmount: number;
      claimedVestedAmount: number;
      totalClaimedAmount: number;
    }
  ): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/claim`;
    const { data } = await firstValueFrom(
      this.httpService.post(url, payload, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  /**
   * Phase 1 of the witness flow.
   * Calls l4va-rewards to atomically reserve the claim and build an unsigned
   * Cardano transaction in a single operation. The txCbor is stored server-side
   * in the reservation, eliminating the need for a separate store-hash call.
   *
   * Returns { reservationId, txCbor, amounts } to the client.
   * The client signs txCbor via CIP-30 signTx() and calls submitClaim().
   */
  async prepareClaim(
    walletAddress: string,
    payload: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean }
  ): Promise<PrepareClaimResponseDto> {
    try {
      const url = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/${walletAddress}/prepare`;
      const { data } = await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: { 'X-Internal-Service-Token': this.internalToken },
        })
      );

      this.logger.log(
        `Claim prepared for ${walletAddress.slice(0, 12)}...: reservation ${data.reservationId} ` +
          `${(data.totalClaimableAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
      );

      return {
        reservationId: data.reservationId,
        txCbor: data.txCbor,
        claimableImmediateAmount: data.claimableImmediateAmount / 10 ** this.l4vaDecimals,
        claimableVestedAmount: data.claimableVestedAmount / 10 ** this.l4vaDecimals,
        totalClaimableAmount: data.totalClaimableAmount / 10 ** this.l4vaDecimals,
      };
    } catch (error: any) {
      if (error.response?.status === 409) {
        throw new ConflictException(error.response?.data?.message || 'Claim already in progress');
      }
      if (error.response?.status === 404) {
        throw new NotFoundException(error.response?.data?.message || 'No claimable rewards found');
      }
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException(error?.message || 'Claim prepare failed');
    }
  }

  /**
   * Phase 2 of the witness flow.
   * Sends the user's CIP-30 witness to l4va-rewards, which assembles the stored
   * txCbor with the treasury key + user witness, submits to the blockchain,
   * and confirms the reservation — all in a single call.
   *
   * @param reservationId - ID returned by prepareClaim
   * @param userWitness   - Hex witness set from CIP-30 signTx()
   */
  async submitClaim(
    walletAddress: string,
    reservationId: string,
    _txCbor: string, // kept for API compatibility; txCbor is now stored server-side
    userWitness: string
  ): Promise<SubmitClaimResponseDto> {
    try {
      const url = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/submit`;
      const { data } = await firstValueFrom(
        this.httpService.post(
          url,
          { reservationId, walletAddress, userWitness },
          { headers: { 'X-Internal-Service-Token': this.internalToken } }
        )
      );

      this.logger.log(
        `Claim submitted: reservation ${reservationId} - tx: ${data.txHash} - ` +
          `${(data.totalClaimedAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
      );

      return {
        success: true,
        txHash: data.txHash,
        claimedAmount: data.totalClaimedAmount / 10 ** this.l4vaDecimals,
        claimedImmediateAmount: data.claimedImmediateAmount / 10 ** this.l4vaDecimals,
        claimedVestedAmount: data.claimedVestedAmount / 10 ** this.l4vaDecimals,
      };
    } catch (error: any) {
      if (error.response?.status === 409) {
        throw new ConflictException(error.response?.data?.message || 'Claim already in progress');
      }
      if (error.response?.status === 404) {
        throw new NotFoundException(error.response?.data?.message || 'Reservation not found');
      }
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadRequestException(error?.message || 'Claim submit failed');
    }
  }

  /**
   * Cancel a pending reservation — called when the user declines signing in their wallet.
   * Safe to call at any time; a missing or already-processed reservation is a no-op.
   */
  async cancelClaim(walletAddress: string, reservationId: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/cancel`;
      const { data } = await firstValueFrom(
        this.httpService.post(
          url,
          { reservationId, walletAddress, errorReason: 'Cancelled by user' },
          { headers: { 'X-Internal-Service-Token': this.internalToken } }
        )
      );
      this.logger.log(`Reservation ${reservationId} cancelled by user`);
      return { success: data.success, message: data.message };
    } catch (error: any) {
      // Non-fatal — reservation will be cleaned up by the cron if this fails
      this.logger.warn(`Failed to cancel reservation ${reservationId}: ${error?.message}`);
      return { success: false, message: error?.message || 'Cancel failed' };
    }
  }

  // ============================================================================
  // Vesting Methods
  // ============================================================================

  async getVestingPositions(walletAddress: string): Promise<VestingSummaryDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/summary`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getActiveVesting(walletAddress: string): Promise<VestingPositionsResponseDto> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/active`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  async getWeights(): Promise<Record<string, any>> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/weights`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }
}
