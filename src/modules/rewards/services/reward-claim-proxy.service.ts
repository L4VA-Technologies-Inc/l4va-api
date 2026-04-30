import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

import { RewardsClaimTxBuilderService } from './rewards-claim-tx-builder.service';

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
    private readonly configService: ConfigService,
    private readonly txBuilder: RewardsClaimTxBuilderService
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

  async getEpochs(limit = 20, offset = 0): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs?limit=${limit}&offset=${offset}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getCurrentEpoch(): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/current`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getEpochById(epochId: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/${epochId}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Score & History Methods
  // ============================================================================

  async getWalletScore(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/score/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getAlignmentDetails(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/alignment/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletHistory(walletAddress: string, limit = 20): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/history/${walletAddress}?limit=${limit}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Vault Rewards Methods
  // ============================================================================

  async getVaultScores(vaultId: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vault/${vaultId}/scores${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaultReward(walletAddress: string, vaultId: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vault/${vaultId}${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaults(walletAddress: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vaults${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletVaultTimeline(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/vaults`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getWalletActivityTimeline(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/activities`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getCurrentEpochEstimate(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/current-estimate`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Claims Methods
  // ============================================================================

  async getAvailableClaims(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimableSummary(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/claimable`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimHistory(walletAddress: string, limit = 50): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/history?limit=${limit}`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getClaimTransactions(walletAddress: string, limit = 50): Promise<any> {
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
   * Build and execute a claim transaction with on-chain payment using atomic reservation.
   * Flow:
   * 1. Reserve claim atomically (prevents race condition)
   * 2. Build and submit blockchain transaction
   * 3. ONLY IF SUCCESSFUL with txHash → Confirm reservation
   * 4. On ANY error → Rollback reservation
   *
   * Throws BadRequestException on failure WITHOUT persisting any claim changes.
   */
  async buildAndExecuteClaim(
    walletAddress: string,
    payload: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean }
  ): Promise<{
    success: boolean;
    txHash: string;
    claimedAmount: number;
    claimedImmediateAmount: number;
    claimedVestedAmount: number;
  }> {
    let reservation: { claimTransactionId: string; reservationId: string; totalClaimableAmount: number } | null = null;
    let txHash: string | null = null;

    try {
      // ============================================================
      // STEP 1: ATOMIC RESERVATION (prevents race condition)
      // ============================================================
      this.logger.log(`Reserving claim for wallet ${walletAddress.slice(0, 20)}...`);

      const reserveUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/${walletAddress}/reserve`;
      const { data } = await firstValueFrom(
        this.httpService.post(reserveUrl, payload, {
          headers: { 'X-Internal-Service-Token': this.internalToken },
        })
      );

      reservation = {
        claimTransactionId: data.claimTransactionId,
        reservationId: data.reservationId,
        totalClaimableAmount: data.totalClaimableAmount,
      };

      this.logger.log(
        `Claim reserved: ${reservation.reservationId} - ${(reservation.totalClaimableAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
      );

      // ============================================================
      // STEP 2: BUILD, SIGN & SUBMIT BLOCKCHAIN TRANSACTION
      // ============================================================
      const txResult = await this.txBuilder.buildClaimTransaction(walletAddress, reservation.totalClaimableAmount);

      if (!txResult.success || !txResult.txHash) {
        throw new BadRequestException(txResult.error || 'Blockchain transaction failed');
      }

      txHash = txResult.txHash;
      this.logger.log(`Blockchain tx submitted: ${txHash}`);

      // ============================================================
      // STEP 3: CONFIRM RESERVATION (only after successful tx submission)
      // ============================================================
      try {
        const confirmUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/confirm`;
        const { data: confirmed } = await firstValueFrom(
          this.httpService.post(
            confirmUrl,
            {
              reservationId: reservation.reservationId,
              txHash,
            },
            { headers: { 'X-Internal-Service-Token': this.internalToken } }
          )
        );

        this.logger.log(
          `Claim confirmed: ${reservation.reservationId} - tx: ${txHash} - ` +
            `${(confirmed.totalClaimedAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
        );

        // Return human-readable amounts
        return {
          success: true,
          txHash,
          claimedAmount: confirmed.totalClaimedAmount / 10 ** this.l4vaDecimals,
          claimedImmediateAmount: confirmed.claimedImmediateAmount / 10 ** this.l4vaDecimals,
          claimedVestedAmount: confirmed.claimedVestedAmount / 10 ** this.l4vaDecimals,
        };
      } catch (confirmError: any) {
        // ============================================================
        // CRITICAL: TX SUBMITTED BUT CONFIRMATION FAILED
        // DO NOT ROLLBACK - log as pending and throw retryable error
        // ============================================================
        this.logger.error(
          `CRITICAL: Blockchain tx ${txHash} submitted successfully but confirmation failed: ${confirmError?.message || confirmError}. ` +
            `Reservation ${reservation.reservationId} is marked PENDING. Manual intervention or retry may be needed.`,
          confirmError?.stack
        );

        throw new BadRequestException(
          `Claim transaction submitted on-chain (tx: ${txHash}) but confirmation failed. ` +
            `The transaction may still complete. Please check transaction status before retrying.`
        );
      }
    } catch (error: any) {
      // ============================================================
      // STEP 4: ROLLBACK ONLY IF RESERVATION EXISTS AND NO TXHASH
      // ============================================================
      if (reservation?.claimTransactionId && !txHash) {
        try {
          this.logger.error(
            `Claim failed before blockchain submission, rolling back reservation ${reservation.reservationId}...`
          );
          const rollbackUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/rollback`;
          await firstValueFrom(
            this.httpService.post(
              rollbackUrl,
              {
                reservationId: reservation.reservationId,
                errorReason: error?.message || 'Unknown error',
              },
              { headers: { 'X-Internal-Service-Token': this.internalToken } }
            )
          );
          this.logger.log(`Reservation ${reservation.reservationId} rolled back successfully`);
        } catch (rollbackError: any) {
          this.logger.error(`CRITICAL: Failed to rollback reservation: ${rollbackError?.message || rollbackError}`);
        }
      } else if (txHash) {
        // Transaction was submitted on-chain - DO NOT rollback
        this.logger.error(
          `Claim processing failed but blockchain tx ${txHash} already submitted. NOT rolling back reservation.`
        );
      }

      // Re-throw original error
      if (error.name === 'BadRequestException' || error.name === 'ConflictException') {
        throw error;
      }
      this.logger.error(`Failed to build and execute claim: ${error?.message || error}`, error?.stack);
      throw new BadRequestException(error?.message || 'Claim transaction failed');
    }
  }

  // ============================================================================
  // Vesting Methods
  // ============================================================================

  async getVestingPositions(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/summary`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  async getActiveVesting(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/active`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  async getWeights(): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/weights`;
    const { data } = await firstValueFrom(
      this.httpService.get(url, { headers: { 'X-Internal-Service-Token': this.internalToken } })
    );
    return data;
  }
}
