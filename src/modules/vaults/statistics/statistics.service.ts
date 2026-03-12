import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Not, Repository } from 'typeorm';

import { VaultStatisticsResponse } from '../dto/get-vaults-statistics.dto';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { PriceService } from '@/modules/price/price.service';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class StatisticsService {
  private readonly logger = new Logger(StatisticsService.name);
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    private readonly configService: ConfigService,
    private readonly priceService: PriceService,
    private readonly systemSettingsService: SystemSettingsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Retrieves statistics about vaults for the landing page.
   *
   * @returns Object containing platform statistics
   */
  async getVaultStatistics(): Promise<VaultStatisticsResponse> {
    try {
      // Count active vaults (published, contribution, acquire, locked, expansion), excluding hidden vaults on mainnet
      const activeVaultsWhere: any = {
        vault_status: In([VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked, VaultStatus.expansion]),
        deleted: false,
      };
      if (this.isMainnet) {
        activeVaultsWhere.id = Not(In(this.systemSettingsService.hiddenMainnetVaultIds));
      }
      const activeVaultsCount = await this.vaultsRepository.count({
        where: activeVaultsWhere,
      });

      const totalVaultsWhere: any = {
        vault_status: In([
          VaultStatus.published,
          VaultStatus.contribution,
          VaultStatus.acquire,
          VaultStatus.locked,
          VaultStatus.expansion,
        ]),
      };
      if (this.isMainnet) {
        totalVaultsWhere.id = Not(In(this.systemSettingsService.hiddenMainnetVaultIds));
      }
      const totalVaultsCount = await this.vaultsRepository.count({
        where: totalVaultsWhere,
      });
      // Get sum of total assets value for locked and expansion vaults only, excluding hidden vaults on mainnet
      const totalValueQuery = this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status IN (:...statuses)', { statuses: [VaultStatus.locked, VaultStatus.expansion] })
        .andWhere('vault.deleted = :deleted', { deleted: false });
      if (this.isMainnet) {
        totalValueQuery.andWhere('vault.id NOT IN (:...hiddenIds)', {
          hiddenIds: this.systemSettingsService.hiddenMainnetVaultIds,
        });
      }
      const totalValueResult = await totalValueQuery.getRawOne();

      // Count total assets contributed across all vaults, excluding hidden vaults on mainnet
      const totalContributedQuery = this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status IN (:...statuses)', {
          statuses: [
            VaultStatus.contribution,
            VaultStatus.acquire,
            VaultStatus.locked,
            VaultStatus.failed,
            VaultStatus.expansion,
          ],
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
      const totalAcquiredQuery = this.vaultsRepository
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
          statuses: [
            VaultStatus.contribution,
            VaultStatus.acquire,
            VaultStatus.locked,
            VaultStatus.burned,
            VaultStatus.expansion,
          ],
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
        expansion: { percentage: 0, valueAda: '0', valueUsd: '0' },
      };

      const statusMap = {
        contribution: 'contribution',
        acquire: 'acquire',
        locked: 'locked',
        burned: 'terminated',
        expansion: 'expansion',
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
        expansion: { percentage: 0, valueAda: '0', valueUsd: '0' },
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
}
