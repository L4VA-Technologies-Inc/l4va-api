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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly txBuilder: RewardsClaimTxBuilderService
  ) {
    // Default to local dev setup (localhost:4000)
    // Testnet/Mainnet MUST set REWARDS_SERVICE_URL explicitly (e.g., http://l4va-rewards:3001 for Docker)
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:4000');
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

  async getAlignmentDetails(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/alignment/${walletAddress}`;
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
    const { data } = await firstValueFrom(this.httpService.post(url, payload));
    return data;
  }

  /**
   * Build and execute a claim transaction with on-chain payment.
   * This method:
   * 1. Gets claimable amounts (read-only)
   * 2. Builds the Cardano transaction using Lucid
   * 3. Signs and submits the transaction to blockchain
   * 4. ONLY IF SUCCESSFUL with tx_hash, updates the database
   *
   * Throws BadRequestException on failure WITHOUT any database changes.
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
    try {
      // Step 1: Get claimable amounts (read-only, no DB changes)
      this.logger.log(`Getting claimable amounts for wallet ${walletAddress.slice(0, 20)}...`);
      const claimableSummary = await this.getClaimableSummary(walletAddress);

      const totalClaimableNow = claimableSummary.totalClaimable || 0;

      if (totalClaimableNow <= 0) {
        throw new BadRequestException('No claimable amount available');
      }

      // Step 2: Build, sign, and submit the Cardano transaction
      this.logger.log(`Building and submitting transaction for ${totalClaimableNow} L4VA tokens...`);
      const txResult = await this.txBuilder.buildClaimTransaction(walletAddress, totalClaimableNow);

      if (!txResult.success || !txResult.txHash) {
        throw new BadRequestException(txResult.error || 'Transaction building/submission failed');
      }

      // Step 3: ONLY NOW update the database with successful transaction
      this.logger.log(`Transaction successful with hash ${txResult.txHash}, updating database...`);
      await this.executeClaim(walletAddress, {
        ...payload,
        txHash: txResult.txHash,
        claimedImmediateAmount: claimableSummary.immediateClaimable || 0,
        claimedVestedAmount: claimableSummary.vestedClaimable || 0,
        totalClaimedAmount: totalClaimableNow,
      });

      this.logger.log(
        `✅ Successfully claimed ${totalClaimableNow} L4VA with tx ${txResult.txHash} for ${walletAddress.slice(0, 20)}...`
      );

      return {
        success: true,
        txHash: txResult.txHash,
        claimedAmount: totalClaimableNow,
        claimedImmediateAmount: claimableSummary.immediateClaimable || 0,
        claimedVestedAmount: claimableSummary.vestedClaimable || 0,
      };
    } catch (error: any) {
      if (error.name === 'BadRequestException') {
        throw error;
      }
      this.logger.error(`Failed to build and execute claim: ${error?.message || error}`, error?.stack);
      throw new BadRequestException(error?.message || 'Unknown error occurred');
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
