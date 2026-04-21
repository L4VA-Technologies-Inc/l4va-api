import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly txBuilder: RewardsClaimTxBuilderService
  ) {
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:3001');
  }

  // ============================================================================
  // Epoch Methods
  // ============================================================================

  async getEpochs(limit = 20, offset = 0): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs?limit=${limit}&offset=${offset}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getCurrentEpoch(): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/current`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getEpochById(epochId: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/epochs/${epochId}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  // ============================================================================
  // Score & History Methods
  // ============================================================================

  async getWalletScore(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/score/${walletAddress}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getWalletHistory(walletAddress: string, limit = 20): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/history/${walletAddress}?limit=${limit}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  // ============================================================================
  // Vault Rewards Methods
  // ============================================================================

  async getVaultScores(vaultId: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vault/${vaultId}/scores${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getWalletVaultReward(walletAddress: string, vaultId: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vault/${vaultId}${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getWalletVaults(walletAddress: string, epochId?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/vaults${epochId ? `?epochId=${epochId}` : ''}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getWalletVaultTimeline(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/vaults`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getWalletActivityTimeline(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/timeline/activities`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getCurrentEpochEstimate(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/wallet/${walletAddress}/current-estimate`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  // ============================================================================
  // Claims Methods
  // ============================================================================

  async getAvailableClaims(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getClaimableSummary(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/claimable`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getClaimHistory(walletAddress: string, limit = 50): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/history?limit=${limit}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getClaimTransactions(walletAddress: string, limit = 50): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/transactions?limit=${limit}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async executeClaim(
    walletAddress: string,
    payload: { epochIds?: string[]; claimImmediate?: boolean; claimVested?: boolean; transactionId: string }
  ): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/${walletAddress}/claim`;
    const { data } = await firstValueFrom(this.httpService.post(url, payload));
    return data;
  }

  /**
   * Mark claim transactions as failed and rollback claimed amounts.
   * This should be called if the on-chain transaction fails.
   */
  async failClaimTransaction(transactionId: string): Promise<void> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/claims/fail`;
    await firstValueFrom(this.httpService.post(url, { claimTransactionIds: [transactionId] }));
    this.logger.log(`Rolled back claim transaction ${transactionId}`);
  }

  /**
   * Build and execute a claim transaction with on-chain payment.
   * This method:
   * 1. Calls l4va-rewards to update DB state
   * 2. Builds the Cardano transaction using Lucid
   * 3. Signs and submits the transaction to blockchain
   * 4. Returns the transaction hash
   *
   * Throws BadRequestException on failure with automatic rollback.
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
    // Generate a proper UUID for this claim transaction
    const transactionId = uuidv4();

    try {
      // Step 1: Call l4va-rewards to update DB state
      this.logger.log(`Executing claim for wallet ${walletAddress.slice(0, 20)}...`);
      const claimResult = await this.executeClaim(walletAddress, {
        ...payload,
        transactionId,
      });

      if (!claimResult.success) {
        throw new BadRequestException(claimResult.error || 'Claim execution failed');
      }

      const totalClaimedAmount = claimResult.totalClaimedAmount || 0;

      if (totalClaimedAmount <= 0) {
        throw new BadRequestException('No claimable amount available');
      }

      // Step 2: Build, sign, and submit the Cardano transaction
      this.logger.log(`Building and submitting transaction for ${totalClaimedAmount} L4VA tokens...`);
      const txResult = await this.txBuilder.buildClaimTransaction(walletAddress, totalClaimedAmount);

      if (!txResult.success) {
        // Rollback claim state if transaction building/submission fails
        this.logger.error(`Transaction failed, rolling back claim for tx: ${transactionId}`);
        await this.failClaimTransaction(transactionId);
        throw new BadRequestException(txResult.error || 'Transaction building/submission failed');
      }

      this.logger.log(
        `✅ Successfully submitted claim transaction ${txResult.txHash} for ${totalClaimedAmount} L4VA to ${walletAddress.slice(0, 20)}...`
      );

      return {
        success: true,
        txHash: txResult.txHash!,
        claimedAmount: totalClaimedAmount,
        claimedImmediateAmount: claimResult.claimedImmediateAmount || 0,
        claimedVestedAmount: claimResult.claimedVestedAmount || 0,
      };
    } catch (error: any) {
      // If we haven't thrown a BadRequestException yet, rollback and throw
      if (error.name !== 'BadRequestException') {
        this.logger.error(`Failed to build and execute claim: ${error?.message || error}`, error?.stack);
        try {
          await this.failClaimTransaction(transactionId);
        } catch (rollbackError: any) {
          this.logger.error(`Failed to rollback transaction ${transactionId}: ${rollbackError?.message}`);
        }
        throw new BadRequestException(error?.message || 'Unknown error occurred');
      }
      throw error;
    }
  }

  // ============================================================================
  // Vesting Methods
  // ============================================================================

  async getVestingPositions(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/summary`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getActiveVesting(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/vesting/${walletAddress}/active`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  // ============================================================================
  // Configuration Methods
  // ============================================================================

  async getWeights(): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/weights`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }
}
