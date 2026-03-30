import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Thin client for l4va-rewards service endpoints.
 * Used by l4va-api to proxy claim operations to the rewards service.
 */
@Injectable()
export class RewardClaimProxy {
  private readonly logger = new Logger(RewardClaimProxy.name);
  private readonly rewardsBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:3001');
  }

  async getAvailableClaims(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/rewards/claims/${walletAddress}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async markClaimed(walletAddress: string, claimIds: string[], transactionId: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/rewards/claims/${walletAddress}/mark-claimed`;
    const { data } = await firstValueFrom(this.httpService.post(url, { claimIds, transactionId }));
    return data;
  }

  async getClaimHistory(walletAddress: string, limit = 50): Promise<any> {
    const url = `${this.rewardsBaseUrl}/rewards/claims/${walletAddress}/history?limit=${limit}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getVestingPositions(walletAddress: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/rewards/vesting/${walletAddress}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }
}
