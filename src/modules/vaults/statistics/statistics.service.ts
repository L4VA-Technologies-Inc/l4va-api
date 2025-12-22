import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';

import { Vault } from '@/database/vault.entity';
import { GetVTPriceRes, GetVTStatisticRes, GetVTHistoryRes } from '@/modules/vaults/statistics/dto/get-statistic.res';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);
  private readonly apiKey: string;
  private readonly charli3ApiUrl: string;
  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.apiKey = this.configService.get<string>('CHARLI3_API_KEY');
    this.charli3ApiUrl = this.configService.get<string>('CHARLI3_API_URL');
  }

  async getTokenPrice(vaultId: string): Promise<GetVTPriceRes> {
    const policyId = '95a427e384527065f2f8946f5e86320d0117839a5e98ea2c0b55fb0048554e54';

    try {
      this.logger.log(`Fetching statistics from Charli3 for vault ${vaultId} with policy ${policyId}`);

      const response = await firstValueFrom(
        this.httpService.get(`${this.charli3ApiUrl}/tokens/current`, {
          params: { policy: policyId },
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        })
      );

      this.logger.log(`Fetched price for vault ${vaultId}: ${JSON.stringify(response.data)}`);

      return response.data;
    } catch (error) {
      this.logger.error('Error getting vault token statistics', error);
      throw error;
    }
  }

  async getTokenHistory(vaultId: string): Promise<GetVTHistoryRes> {
    const symbol =
      'fa8dee6cf0627a82a2610019596758fc36c1ebc4b7e389fdabc44857fdf5c9b0e29ac56f1a584bccd487c445ad45383c6347d03d39869f759daad68284781723';
    const resolution = '60min';
    const days = 3;

    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 24 * 60 * 60;

    try {
      this.logger.log(`Fetching token history for ${symbol} (Hardcoded)`);

      const params = {
        symbol: symbol,
        resolution: resolution,
        from: from,
        to: to,
      };

      const response = await firstValueFrom(
        this.httpService.get(`${this.charli3ApiUrl}/history`, {
          params,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        })
      );

      this.logger.log(`Fetched history for vault ${vaultId}: ${JSON.stringify(response.data)}`);

      return response.data;
    } catch (error) {
      this.logger.error(`Error getting token history for vault ${vaultId}`, error);
      throw error;
    }
  }

  async getVaultTokenStatistics(vaultId: string): Promise<GetVTStatisticRes> {
    const vault = await this.vaultsRepository.findOneBy({ id: vaultId });

    if (!vault) {
      throw new NotFoundException(`Vault with id ${vaultId} not found.`);
    }

    // const policyId = vault.policy_id;
    //
    // if (!policyId) {
    //   this.logger.warn(`Vault ${vaultId} does not have a policy ID configured.`);
    //   throw new NotFoundException(`Policy ID for vault ${vaultId} not found.`);
    // }

    const tokenPrice = await this.getTokenPrice(vaultId);
    const tokenHistory = await this.getTokenHistory(vaultId);

    return {
      tokenPrice,
      tokenHistory,
    };
  }
}
