import { createHash } from 'crypto';

import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, ConflictException, NotFoundException } from '@nestjs/common';
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
   * Phase 1 of the witness flow.
   * Atomically reserves the claim in l4va-rewards, then builds an unsigned
   * Cardano transaction that requires the user's wallet to co-sign (requiredSigners).
   *
   * Returns { reservationId, txCbor, totalClaimableAmount } to the client.
   * The client must sign txCbor via CIP-30 signTx() and call submitClaim().
   */
  async prepareClaim(
    walletAddress: string,
    payload: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean }
  ): Promise<{
    reservationId: string;
    txCbor: string;
    claimableImmediateAmount: number;
    claimableVestedAmount: number;
    totalClaimableAmount: number;
  }> {
    let reservation: { reservationId: string; totalClaimableAmount: number } | null = null;

    try {
      // ─── Step 1: Atomic reservation ───────────────────────────────────────
      const reserveUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/${walletAddress}/reserve`;
      const { data } = await firstValueFrom(
        this.httpService.post(reserveUrl, payload, {
          headers: { 'X-Internal-Service-Token': this.internalToken },
        })
      );

      reservation = {
        reservationId: data.reservationId,
        totalClaimableAmount: data.totalClaimableAmount,
      };

      this.logger.log(
        `Claim reserved for prepare: ${reservation.reservationId} - ` +
          `${(reservation.totalClaimableAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
      );

      // ─── Step 2: Build unsigned tx (no submit yet) ────────────────────────
      const txResult = await this.txBuilder.prepareClaimTx(walletAddress, reservation.totalClaimableAmount);

      if (!txResult.success || !txResult.txCbor) {
        throw new BadRequestException(txResult.error || 'Failed to build claim transaction');
      }

      // Store txCbor hash in reservation metadata for later validation (prevents signing oracle)
      const txCborHash = createHash('sha256').update(txResult.txCbor).digest('hex');
      const updateUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/store-txcbor`;
      try {
        await firstValueFrom(
          this.httpService.post(
            updateUrl,
            { reservationId: reservation.reservationId, txCborHash },
            { headers: { 'X-Internal-Service-Token': this.internalToken } }
          )
        );
      } catch (hashStoreError: any) {
        this.logger.error(
          `CRITICAL: Failed to store txCbor hash for ${reservation.reservationId}: ${hashStoreError.message}`
        );
        // Rollback the reservation since we can't validate the tx later
        const rollbackUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/rollback`;
        await firstValueFrom(
          this.httpService.post(
            rollbackUrl,
            {
              reservationId: reservation.reservationId,
              errorReason: 'Failed to store transaction hash',
              walletAddress,
            },
            { headers: { 'X-Internal-Service-Token': this.internalToken } }
          )
        ).catch(() => {});
        throw new BadRequestException('Failed to prepare claim transaction. Please try again.');
      }

      return {
        reservationId: reservation.reservationId,
        txCbor: txResult.txCbor,
        claimableImmediateAmount: data.claimableImmediateAmount / 10 ** this.l4vaDecimals,
        claimableVestedAmount: data.claimableVestedAmount / 10 ** this.l4vaDecimals,
        totalClaimableAmount: data.totalClaimableAmount / 10 ** this.l4vaDecimals,
      };
    } catch (error: any) {
      // Roll back if reservation succeeded but tx build failed
      if (reservation?.reservationId) {
        try {
          const rollbackUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/rollback`;
          await firstValueFrom(
            this.httpService.post(
              rollbackUrl,
              { reservationId: reservation.reservationId, errorReason: error?.message || 'Tx build failed' },
              { headers: { 'X-Internal-Service-Token': this.internalToken } }
            )
          );
          this.logger.log(`Reservation ${reservation.reservationId} rolled back after prepare failure`);
        } catch (rollbackError: any) {
          this.logger.error(`CRITICAL: Failed to rollback reservation: ${rollbackError?.message || rollbackError}`);
        }
      }

      // Preserve HTTP status codes from l4va-rewards service
      if (error.response?.status === 409) {
        throw new ConflictException(error.response?.data?.message || 'Claim already in progress');
      }
      if (error.response?.status === 404) {
        throw new NotFoundException(error.response?.data?.message || 'Resource not found');
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
   * Receives the user's CIP-30 witness, assembles + submits the transaction,
   * then confirms the reservation in l4va-rewards.
   *
   * @param reservationId - ID returned by prepareClaim
   * @param txCbor        - Unsigned tx CBOR (same one returned by prepareClaim)
   * @param userWitness   - Hex witness set from CIP-30 signTx()
   */
  async submitClaim(
    walletAddress: string,
    reservationId: string,
    txCbor: string,
    userWitness: string
  ): Promise<{
    success: boolean;
    txHash: string;
    claimedAmount: number;
    claimedImmediateAmount: number;
    claimedVestedAmount: number;
  }> {
    let txHash: string | null = null;

    try {
      // ─── Step 0: Verify txCbor matches reservation (prevents signing oracle) ──
      const txCborHash = createHash('sha256').update(txCbor).digest('hex');
      const verifyUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/verify-txcbor`;

      try {
        await firstValueFrom(
          this.httpService.post(
            verifyUrl,
            { reservationId, txCborHash, walletAddress },
            { headers: { 'X-Internal-Service-Token': this.internalToken } }
          )
        );
      } catch (verifyError: any) {
        // txCbor mismatch or reservation not found
        throw new BadRequestException(verifyError.response?.data?.message || 'Transaction verification failed');
      }

      // ─── Step 1: Submit assembled tx to blockchain ────────────────────────
      const txResult = await this.txBuilder.submitClaimTx(txCbor, userWitness);

      if (!txResult.success) {
        const submitError = txResult.error || 'Blockchain submission failed';

        // If we have no txHash, the submission state is indeterminate:
        // the tx may have been broadcast but timed out, or it may have failed pre-broadcast.
        // We cannot safely rollback because the tx might already be on-chain.
        if (!txResult.txHash) {
          this.logger.error(
            `Claim submission indeterminate for reservation ${reservationId}: ${submitError}. ` +
              `No txHash returned. Reservation will remain PENDING until manual resolution or TTL cleanup.`
          );
          throw new BadRequestException(
            'Transaction submission state is unknown. The transaction may already be on-chain. ' +
              'Check transaction status before retrying.'
          );
        }

        // We have a txHash but submission reported failure - this shouldn't normally happen
        this.logger.error(`Claim submission failed with txHash ${txResult.txHash}: ${submitError}`);
        throw new BadRequestException(submitError);
      }

      if (!txResult.txHash) {
        throw new BadRequestException('Transaction submitted but no hash returned');
      }

      txHash = txResult.txHash;
      this.logger.log(`Claim blockchain tx submitted: ${txHash}`);

      // ─── Step 2: Confirm reservation ──────────────────────────────────────
      try {
        const confirmUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/confirm`;
        const { data: confirmed } = await firstValueFrom(
          this.httpService.post(
            confirmUrl,
            { reservationId, txHash },
            { headers: { 'X-Internal-Service-Token': this.internalToken } }
          )
        );

        this.logger.log(
          `Claim confirmed: ${reservationId} - tx: ${txHash} - ` +
            `${(confirmed.totalClaimedAmount / 10 ** this.l4vaDecimals).toFixed(this.l4vaDecimals)} L4VA`
        );

        return {
          success: true,
          txHash,
          claimedAmount: confirmed.totalClaimedAmount / 10 ** this.l4vaDecimals,
          claimedImmediateAmount: confirmed.claimedImmediateAmount / 10 ** this.l4vaDecimals,
          claimedVestedAmount: confirmed.claimedVestedAmount / 10 ** this.l4vaDecimals,
        };
      } catch (confirmError: any) {
        // Tx is on-chain — do NOT rollback
        this.logger.error(
          `CRITICAL: Blockchain tx ${txHash} submitted but confirmation failed: ${confirmError?.message}. ` +
            `Reservation ${reservationId} is PENDING. Manual intervention may be needed.`,
          confirmError?.stack
        );
        throw new BadRequestException(
          `Claim submitted on-chain (tx: ${txHash}) but confirmation failed. ` +
            `Check transaction status before retrying.`
        );
      }
    } catch (error: any) {
      // If tx was already submitted, never rollback
      if (txHash) {
        this.logger.error(`Claim processing failed but blockchain tx ${txHash} already submitted. NOT rolling back.`);
      }

      if (error instanceof BadRequestException || error instanceof ConflictException) {
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
      const rollbackUrl = `${this.rewardsBaseUrl}/api/v1/internal/rewards/claims/rollback`;
      const { data } = await firstValueFrom(
        this.httpService.post(
          rollbackUrl,
          { reservationId, errorReason: 'Cancelled by user', walletAddress },
          { headers: { 'X-Internal-Service-Token': this.internalToken } }
        )
      );
      this.logger.log(`Reservation ${reservationId} cancelled by user`);
      return { success: data.success, message: data.message };
    } catch (error: any) {
      // Non-fatal — reservation will be cleaned up by the cron if this fails
      this.logger.warn(`Failed to cancel reservation ${reservationId}: ${error?.message}`);
      return { success: false, message: error?.message || 'Rollback failed' };
    }
  }

  /**
   * @deprecated Use prepareClaim + submitClaim instead.
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
      // STEP 4: ERROR HANDLING - NEVER ROLLBACK WITHOUT CERTAINTY
      // ============================================================
      // NOTE: We cannot safely rollback based on !txHash because:
      // - buildClaimTransaction() could have broadcast the tx but timed out returning the hash
      // - In that case, rolling back would allow double-claiming while funds are being transferred
      // - If txHash is missing, treat as indeterminate state and let TTL cleanup handle it

      if (txHash) {
        // Transaction definitely reached the chain - DO NOT rollback
        this.logger.error(
          `Claim processing failed but blockchain tx ${txHash} was submitted. ` +
            `NOT rolling back reservation ${reservation?.reservationId}. Manual intervention may be needed.`
        );
      } else if (reservation?.claimTransactionId) {
        // No txHash but we had a reservation - state is indeterminate
        // The tx may or may not have been broadcast; we cannot safely rollback
        this.logger.error(
          `Claim failed with no txHash for reservation ${reservation.reservationId}. ` +
            `Submission state is indeterminate. Reservation will remain PENDING until TTL cleanup.`
        );
      }

      // Re-throw original error
      if (error instanceof BadRequestException || error instanceof ConflictException) {
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
