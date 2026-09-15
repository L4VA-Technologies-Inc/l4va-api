import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Proxy for admin reward estimation (dry-run scoring) in l4va-rewards service.
 */
@Injectable()
export class RewardEstimateProxy {
  private readonly rewardsBaseUrl: string;
  private readonly internalToken: string;
  private readonly adminToken: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:4000');
    this.internalToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN') || '';
    this.adminToken = this.configService.get<string>('ADMIN_SERVICE_TOKEN') || '';
  }

  async simulateEpochEstimate(body: { epochId?: string; topWalletsLimit?: number }): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/admin/simulate-epoch-estimate`;
    const { data } = await firstValueFrom(
      this.httpService.post(url, body, {
        headers: {
          'X-Internal-Service-Token': this.internalToken,
          Authorization: `Bearer ${this.adminToken}`,
        },
        timeout: 60_000,
      })
    );
    return data;
  }
}
