import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SystemSettings } from '@/database/systemSettings.entity';

export interface SystemSettingsData {
  protocol_enabled: boolean;
  vlrm_creator_fee: number;
  l4va_monthly_budget: number;
  protocol_acquires_fee: number;
  vlrm_creator_fee_enabled: boolean;
  protocol_contributors_fee: number;
  protocol_flat_fee: number;
  lp_recommended_min_liquidity: number;
  auto_create_treasury_wallets: boolean;
  auto_create_treasury_wallets_testnet: boolean;
}

const DEFAULT_SETTINGS: SystemSettingsData = {
  protocol_enabled: true,
  vlrm_creator_fee_enabled: false,
  vlrm_creator_fee: 100,
  l4va_monthly_budget: 1000,
  protocol_acquires_fee: 5000000,
  protocol_contributors_fee: 5000000,
  protocol_flat_fee: 5000000,
  lp_recommended_min_liquidity: 500000000, // 500 ADA
  auto_create_treasury_wallets: false, // Disabled by default for mainnet
  auto_create_treasury_wallets_testnet: false, // Disabled by default for testnet
};

@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);
  private settings: SystemSettingsData = { ...DEFAULT_SETTINGS };

  constructor(
    @InjectRepository(SystemSettings)
    private readonly systemSettingsRepository: Repository<SystemSettings>
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadSettings();
  }

  async loadSettings(): Promise<void> {
    try {
      // Clear the entity manager cache to ensure fresh data
      const settingsRecord = await this.systemSettingsRepository.find({
        cache: false,
      });

      if (settingsRecord?.[0]?.data) {
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...settingsRecord[0].data,
        };
        this.logger.log('System settings loaded from database');
      } else {
        this.logger.warn('No system settings found in database, using defaults');
      }
    } catch (error) {
      this.logger.error('Failed to load system settings:', error);
    }
  }

  async reloadSettings(): Promise<SystemSettingsData> {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.loadSettings();
    return this.settings;
  }

  get protocolEnabled(): boolean {
    return this.settings.protocol_enabled;
  }

  get vlrmCreatorFee(): number {
    return this.settings.vlrm_creator_fee;
  }

  get l4vaMonthlyBudget(): number {
    return this.settings.l4va_monthly_budget;
  }

  get protocolAcquiresFee(): number {
    return this.settings.protocol_enabled ? this.settings.protocol_acquires_fee : 0;
  }

  get vlrmCreatorFeeEnabled(): boolean {
    return this.settings.vlrm_creator_fee_enabled;
  }

  get protocolContributorsFee(): number {
    return this.settings.protocol_enabled ? this.settings.protocol_contributors_fee : 0;
  }

  get protocolFlatFee(): number {
    return this.settings.protocol_enabled ? this.settings.protocol_flat_fee : 0;
  }

  get lpRecommendedMinLiquidity(): number {
    return this.settings.lp_recommended_min_liquidity;
  }

  get autoCreateTreasuryWallets(): boolean {
    const value = this.settings.auto_create_treasury_wallets as boolean | string;
    return value === true || value === 'true';
  }

  get autoCreateTreasuryWalletsTestnet(): boolean {
    const value = this.settings.auto_create_treasury_wallets_testnet as boolean | string;
    return value === true || value === 'true';
  }
}
