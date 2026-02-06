import { HttpService } from '@nestjs/axios';
import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { firstValueFrom } from 'rxjs';
import { In, Not, Repository } from 'typeorm';

import { VaultStatisticsResponse } from '../dto/get-vaults-statistics.dto';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { PriceService } from '@/modules/price/price.service';
import { GetVTPriceRes, GetVTStatisticRes, GetVTHistoryRes } from '@/modules/vaults/statistics/dto/get-statistic.res';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);
  private readonly charli3Key: string;
  private readonly charli3ApiUrl: string;
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly priceService: PriceService,
    private readonly systemSettingsService: SystemSettingsService
  ) {
    this.charli3Key = this.configService.get<string>('CHARLI3_API_KEY');
    this.charli3ApiUrl = this.configService.get<string>('CHARLI3_API_URL');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Retrieves statistics about vaults for the landing page.
   *
   * @returns Object containing platform statistics
   */
  async getVaultStatistics(): Promise<VaultStatisticsResponse> {
    try {
      // Count active vaults (published, contribution, acquire, locked), excluding hidden vaults on mainnet
      const activeVaultsWhere: any = {
        vault_status: In([VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
        deleted: false,
      };
      if (this.isMainnet) {
        activeVaultsWhere.id = Not(In(this.systemSettingsService.hiddenMainnetVaultIds));
      }
      const activeVaultsCount = await this.vaultsRepository.count({
        where: activeVaultsWhere,
      });

      const totalVaultsWhere: any = {
        vault_status: In([VaultStatus.published, VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
      };
      if (this.isMainnet) {
        totalVaultsWhere.id = Not(In(this.systemSettingsService.hiddenMainnetVaultIds));
      }
      const totalVaultsCount = await this.vaultsRepository.count({
        where: totalVaultsWhere,
      });
      // Get sum of total assets value for locked vaults only, excluding hidden vaults on mainnet
      const totalValueQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status = :status', { status: VaultStatus.locked })
        .andWhere('vault.deleted = :deleted', { deleted: false });
      if (this.isMainnet) {
        totalValueQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const totalValueResult = await totalValueQuery.getRawOne();

      // Count total assets contributed across all vaults, excluding hidden vaults on mainnet
      const totalContributedQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status IN (:...statuses)', {
          statuses: [VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked, VaultStatus.failed],
        })
        .andWhere('vault.deleted = :deleted', { deleted: false });
      if (this.isMainnet) {
        totalContributedQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const totalContributedResult = await totalContributedQuery.getRawOne();

      // Count total assets ever contributed (all time, including removed), excluding hidden vaults on mainnet
      const totalAssetsQueryBuilder = this.assetsRepository
        .createQueryBuilder('asset')
        .select('COUNT(asset.id)', 'count');
      if (this.isMainnet) {
        totalAssetsQueryBuilder.andWhere('asset.vault_id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const totalAssetsQuery = await totalAssetsQueryBuilder.getRawOne();

      // Get total acquired value (both ADA and USD) across all vaults, excluding hidden vaults on mainnet
      const totalAcquiredQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_acquired_value_ada)', 'totalAcquiredAda');
      if (this.isMainnet) {
        totalAcquiredQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const totalAcquiredResult = await totalAcquiredQuery.getRawOne();

      const vaultsByStage = await this.getVaultsByStageData();
      const vaultsByType = await this.getVaultsByTypeData();

      const adaPrice = await this.priceService.getAdaPrice();

      const statistics = {
        activeVaults: activeVaultsCount,
        totalVaults: totalVaultsCount,
        totalValueUsd: Number(totalValueResult?.totalValueUsd || 0),
        totalValueAda: Number(totalValueResult?.totalValueAda || 0),
        totalContributedUsd: Number(totalContributedResult?.totalValueUsd || 0),
        totalContributedAda: Number(totalContributedResult?.totalValueAda || 0),
        totalAssets: Number(totalAssetsQuery?.count || 0),
        totalAcquiredAda: Number(totalAcquiredResult?.totalAcquiredAda || 0),
        totalAcquiredUsd: parseFloat((Number(totalAcquiredResult?.totalAcquiredAda || 0) * adaPrice).toFixed(2)),
        vaultsByStage,
        vaultsByType,
      };

      return plainToInstance(VaultStatisticsResponse, statistics, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error('Error retrieving vault statistics:', error);
      throw new InternalServerErrorException('Failed to retrieve vault statistics');
    }
  }

  /**
   * Gets distribution of vaults by stage with TVL in both ADA and USD
   * @returns Record of stages with percentages and TVL values
   */
  private async getVaultsByStageData(): Promise<
    Record<string, { percentage: number; valueAda: string; valueUsd: string }>
  > {
    try {
      // Get TVL by vault status for both currencies, excluding hidden vaults on mainnet
      const statusQuery = this.vaultsRepository
        .createQueryBuilder('vault')
        .select('vault.vault_status', 'status')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'valueAda')
        .addSelect('SUM(vault.total_assets_cost_usd)', 'valueUsd')
        .addSelect('COUNT(vault.id)', 'count')
        .where('vault.deleted = :deleted', { deleted: false })
        .andWhere('vault.vault_status IN (:...statuses)', {
          statuses: ['contribution', 'acquire', 'locked', 'burned'],
        });
      if (this.isMainnet) {
        statusQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const statusResults = await statusQuery.groupBy('vault.vault_status').getRawMany();

      // Calculate total ADA value for percentages
      const totalValueAda = statusResults.reduce((sum, item) => sum + Number(item.valueAda || 0), 0);

      const result = {
        contribution: { percentage: 0, valueAda: '0', valueUsd: '0' },
        acquire: { percentage: 0, valueAda: '0', valueUsd: '0' },
        locked: { percentage: 0, valueAda: '0', valueUsd: '0' },
        terminated: { percentage: 0, valueAda: '0', valueUsd: '0' },
      };

      const statusMap = {
        contribution: 'contribution',
        acquire: 'acquire',
        locked: 'locked',
        burned: 'terminated',
      };

      statusResults.forEach(item => {
        const status = statusMap[item.status] || item.status;
        const valueAda = Number(item.valueAda || 0);
        const valueUsd = Number(item.valueUsd || 0);
        const percentage = totalValueAda > 0 ? (valueAda / totalValueAda) * 100 : 0;

        result[status.toLowerCase()] = {
          percentage: parseFloat(percentage.toFixed(2)),
          valueAda,
          valueUsd,
        };
      });

      return result;
    } catch (error) {
      this.logger.error('Error calculating vaults by stage:', error);
      // Return default object with zero values for all required statuses
      return {
        contribution: { percentage: 0, valueAda: '0', valueUsd: '0' },
        acquire: { percentage: 0, valueAda: '0', valueUsd: '0' },
        locked: { percentage: 0, valueAda: '0', valueUsd: '0' },
        terminated: { percentage: 0, valueAda: '0', valueUsd: '0' },
      };
    }
  }

  /**
   * Gets distribution of vaults by privacy type with TVL in both ADA and USD
   * @returns Record of privacy types with percentages and TVL values
   */
  private async getVaultsByTypeData(): Promise<
    Record<string, { percentage: number; valueAda: number; valueUsd: number }>
  > {
    try {
      const privacyQuery = this.vaultsRepository
        .createQueryBuilder('vault')
        .select('vault.privacy', 'type')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'valueAda')
        .addSelect('SUM(vault.total_assets_cost_usd)', 'valueUsd')
        .addSelect('COUNT(vault.id)', 'count')
        .where('vault.deleted = :deleted', { deleted: false });
      if (this.isMainnet) {
        privacyQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const privacyResults = await privacyQuery.groupBy('vault.privacy').getRawMany();

      const totalValueAda = privacyResults.reduce((sum, item) => sum + Number(item.valueAda || 0), 0);

      const result = {
        private: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
        public: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
        semiPrivate: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
      };

      privacyResults.forEach(item => {
        if (item.type) {
          const type = item.type;
          const valueAda = Number(item.valueAda || 0);
          const valueUsd = Number(item.valueUsd || 0);
          const percentage = parseFloat((totalValueAda > 0 ? (valueAda / totalValueAda) * 100 : 0).toFixed(2)) || 0;

          const key = type === 'semi-private' ? 'semiPrivate' : type.toLowerCase();
          result[key] = {
            percentage,
            valueAda,
            valueUsd,
          };
        }
      });

      return result;
    } catch (error) {
      this.logger.error('Error calculating vaults by type:', error);
      return {
        private: { percentage: 0, valueAda: 0, valueUsd: 0 },
        public: { percentage: 0, valueAda: 0, valueUsd: 0 },
        semiPrivate: { percentage: 0, valueAda: 0, valueUsd: 0 },
      };
    }
  }

  async getTokenPrice(vaultId: string): Promise<GetVTPriceRes> {
    const policyId = '95a427e384527065f2f8946f5e86320d0117839a5e98ea2c0b55fb0048554e54';

    try {
      this.logger.log(`Fetching statistics from Charli3 for vault ${vaultId} with policy ${policyId}`);

      const response = await firstValueFrom(
        this.httpService.get(`${this.charli3ApiUrl}/tokens/current`, {
          params: { policy: policyId },
          headers: {
            Authorization: `Bearer ${this.charli3Key}`,
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
            Authorization: `Bearer ${this.charli3Key}`,
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
