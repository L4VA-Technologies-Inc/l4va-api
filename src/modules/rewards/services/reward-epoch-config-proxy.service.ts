import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

/**
 * Proxy for epoch config operations to l4va-rewards service.
 */
@Injectable()
export class RewardEpochConfigProxy {
  private readonly logger = new Logger(RewardEpochConfigProxy.name);
  private readonly rewardsBaseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    // Default to local dev setup (localhost:4000 is the host-mapped port)
    // Testnet/Mainnet MUST set REWARDS_SERVICE_URL=http://l4va-rewards:3001 for Docker inter-container communication
    this.rewardsBaseUrl = this.configService.get<string>('REWARDS_SERVICE_URL', 'http://localhost:4000');
  }

  async getActiveConfig(): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config/active`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async listConfigs(limit: number, offset: number): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config?limit=${limit}&offset=${offset}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async getConfigByVersion(version: number): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config/${version}`;
    const { data } = await firstValueFrom(this.httpService.get(url));
    return data;
  }

  async createDraft(dto: any): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config`;
    const { data } = await firstValueFrom(this.httpService.post(url, dto));
    return data;
  }

  async activateConfig(version: number, activatedBy: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config/${version}/activate`;
    const { data } = await firstValueFrom(this.httpService.put(url, { activated_by: activatedBy }));
    return data;
  }

  async cloneConfig(version: number, createdBy: string, notes?: string): Promise<any> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config/${version}/clone`;
    const { data } = await firstValueFrom(this.httpService.post(url, { created_by: createdBy, notes }));
    return data;
  }

  async deleteDraft(version: number): Promise<void> {
    const url = `${this.rewardsBaseUrl}/api/v1/rewards/config/${version}`;
    await firstValueFrom(this.httpService.delete(url));
  }
}
