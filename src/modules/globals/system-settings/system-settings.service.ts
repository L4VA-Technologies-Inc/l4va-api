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
  vault_creator_whitelist: string[];
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
  vault_creator_whitelist: [
    'addr1q9j4eqs7v5pz08fddkfng2kvj762jhkhnpen4shr5jtht3evu56kfxkaqdjl4he2d6nguzl489fsvwsnx5554fe4lsjqe0ygg5',
    'addr1q90jnj7v8qmd3ypa668tufp7r663ppkctfd34dfwdfmam9eu2heaaj7eknfhahkydax07wqmvszndrcmh83adfph4umsskaxm5',
    'addr1q88an4qcawhlkkygktem3qy6tt4rjc8ady57yr4rfckg5f9hs7np7g8z3sls33nxgp0gfwnp4p5csnrzpmxd7e8cfadsmgsaqa',
    'addr1q93akfm7lv8fmrmz5ys4hgmen25w926ew2ajnd424gu7hckd7tk2n8t8emvnvynexdm48r8pknnxaryp3acmg9e728ws8f5ldq',
    'addr1qyjvkvzj9zfl9yrf6vgdgwqlqgle3dmly04pvjtr7nmxazs8t80h0pl5k7kpwvl9kz6arta8zy0s5ta4zek7nklrcmzsv02zeu',
    'addr1q8jke473vvl366nulxl2ry5m6nejlxxxdd5ettpe60uue0x7qpa0aemr2kc2cttksuha7q7z4eyf932trku5e8pv0uvscghq6d',
    'addr1qy24hqr2cysjjsqz0svkan2cdflkdvzk4xzfcph9479xh89a798wmjp29yclfhd3528pz02n45jzv57d7r84nfk60pssfs4txw',
    'addr1qyefjlxuepw7sge68f2mzz380hc64tw3nldhfeqld7wu0nn5wdv7nwezdwmsm38527cxt2547a88rvjyx34r4f7wpkjqjgkusw',
  ],
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

  get vaultCreatorWhitelist(): string[] {
    return this.settings.vault_creator_whitelist || [];
  }

  isAddressWhitelistedForVaultCreation(address: string): boolean {
    const whitelist = this.vaultCreatorWhitelist;
    // If whitelist is empty, allow all addresses
    if (!whitelist || whitelist.length === 0) {
      return true;
    }
    return whitelist.includes(address);
  }
}
