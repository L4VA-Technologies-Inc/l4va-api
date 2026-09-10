import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  // Per-asset contribution fee: charged per NFT or per FT type (quantity ignored)
  protocol_fee_per_asset: number;
  lp_recommended_min_liquidity: number;
  max_acquire_amount_ada: number;
  auto_create_treasury_wallets: boolean;
  auto_create_treasury_wallets_testnet: boolean;
  vault_creator_whitelist: string[];
  hidden_mainnet_vault_ids: string[];
  // Kill switches for sensitive flows
  vault_creation_enabled: boolean;
  contribution_enabled: boolean;
  acquire_enabled: boolean;
  governance_enabled: boolean;
  // Governance fees (in lovelace)
  governance_fee_proposal_staking: number;
  governance_fee_proposal_distribution: number;
  governance_fee_proposal_termination: number;
  governance_fee_proposal_burning: number;
  governance_fee_proposal_marketplace_action: number;
  governance_fee_proposal_expansion: number;
  governance_fee_proposal_asset_whitelist_update: number;
  governance_fee_voting: number; // Fee per vote
  /**
   * EVM (Robinhood) governance fees, in wei, as decimal strings.
   *
   * Deliberately separate from the lovelace keys above rather than converted:
   * a 5 ADA fee and a 0.001 ETH fee are unrelated numbers, and a converted fee
   * would drift with price between the quote and the payment. Strings because
   * wei exceeds Number.MAX_SAFE_INTEGER.
   */
  governance_fee_proposal_staking_evm: string;
  governance_fee_proposal_distribution_evm: string;
  governance_fee_proposal_termination_evm: string;
  governance_fee_proposal_burning_evm: string;
  governance_fee_proposal_marketplace_action_evm: string;
  governance_fee_proposal_expansion_evm: string;
  governance_fee_proposal_asset_whitelist_update_evm: string;
  governance_fee_voting_evm: string; // Fee per vote
  // Voting duration constraints (in milliseconds)
  min_voting_duration: number;
  max_voting_duration: number;
  // Price deviation protection settings
  price_max_deviation_percent_nft: number;
  price_max_deviation_percent_ft: number;
  price_min_absolute_move_ada: number;
  price_min_asset_price_for_deviation_check_ada: number;
  // EVM termination preflight (Robinhood). Operational policy only — contract
  // solvency does not depend on these; see EvmTerminationPreflightService.
  evm_termination_max_pool_vt_bps: number;
  evm_termination_pool_data_max_age_seconds: number;
  evm_termination_sweep_delay_days: number;
  /**
   * Waivers let the authority exclude an asset from the distribution and route
   * it to the treasury at the deadline. The on-chain cap bounds the COUNT, not
   * the VALUE, so this stays off until a dust/approval policy is defined.
   */
  evm_termination_allow_waivers: boolean;
}

const DEFAULT_SETTINGS: SystemSettingsData = {
  protocol_enabled: true,
  vlrm_creator_fee_enabled: false,
  vlrm_creator_fee: 100,
  l4va_monthly_budget: 1000,
  protocol_acquires_fee: 5000000,
  protocol_contributors_fee: 5000000,
  protocol_flat_fee: 5000000,
  protocol_fee_per_asset: 2_000_000, // 2 ADA per asset entry (NFT or FT type, qty ignored)
  lp_recommended_min_liquidity: 500000000, // 500 ADA
  max_acquire_amount_ada: 10000000, // 10M ADA default limit
  auto_create_treasury_wallets: false, // Disabled by default for mainnet
  auto_create_treasury_wallets_testnet: false, // Disabled by default for testnet
  // Kill switches for sensitive flows
  vault_creation_enabled: true,
  contribution_enabled: true,
  acquire_enabled: true,
  governance_enabled: true,
  // Governance fees (in lovelace)
  governance_fee_proposal_staking: 5000000, // 5 ADA
  governance_fee_proposal_distribution: 5000000, // 5 ADA
  governance_fee_proposal_termination: 10000000, // 10 ADA
  governance_fee_proposal_burning: 3000000, // 3 ADA
  governance_fee_proposal_marketplace_action: 5000000, // 5 ADA
  governance_fee_proposal_expansion: 10000000, // 10 ADA
  governance_fee_proposal_asset_whitelist_update: 5000000, // 5 ADA
  governance_fee_voting: 0, // No voting fee by default
  // EVM governance fees (wei, decimal strings). Small non-zero test values so the
  // flow is exercised end-to-end; tune per proposal type from admin settings.
  governance_fee_proposal_staking_evm: '100000000000000', // 0.0001 ETH
  governance_fee_proposal_distribution_evm: '100000000000000', // 0.0001 ETH
  governance_fee_proposal_termination_evm: '200000000000000', // 0.0002 ETH
  governance_fee_proposal_burning_evm: '100000000000000', // 0.0001 ETH
  governance_fee_proposal_marketplace_action_evm: '100000000000000', // 0.0001 ETH
  governance_fee_proposal_expansion_evm: '200000000000000', // 0.0002 ETH
  governance_fee_proposal_asset_whitelist_update_evm: '100000000000000', // 0.0001 ETH
  governance_fee_voting_evm: '10000000000000', // 0.00001 ETH
  // Voting duration constraints (in milliseconds)
  min_voting_duration: 86400000, // 24 hours in ms
  max_voting_duration: 259200000, // 3 days in ms
  // Price deviation protection defaults
  price_max_deviation_percent_nft: 400,
  price_max_deviation_percent_ft: 150,
  price_min_absolute_move_ada: 0,
  // Keep this low so deviation checks apply to typical FT price feeds by default
  price_min_asset_price_for_deviation_check_ada: 0.1,
  // 5% of VT supply sitting in pools. Above this, holders would be handed LP
  // tokens whose VT side is dying, because LP removal is not implemented yet.
  evm_termination_max_pool_vt_bps: 500,
  evm_termination_pool_data_max_age_seconds: 300,
  // Mirrors the contract's MIN_SWEEP_DELAY floor; the contract rejects less.
  evm_termination_sweep_delay_days: 90,
  evm_termination_allow_waivers: false,
  hidden_mainnet_vault_ids: ['00000000-0000-0000-0000-000000000000'],
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
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(SystemSettings)
    private readonly systemSettingsRepository: Repository<SystemSettings>,
    private readonly configService: ConfigService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

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

  get protocolFeePerAsset(): number {
    return this.settings.protocol_enabled
      ? (this.settings.protocol_fee_per_asset ?? DEFAULT_SETTINGS.protocol_fee_per_asset)
      : 0;
  }

  get evmTerminationMaxPoolVtBps(): number {
    return this.settings.evm_termination_max_pool_vt_bps;
  }

  get evmTerminationPoolDataMaxAgeSeconds(): number {
    return this.settings.evm_termination_pool_data_max_age_seconds;
  }

  get evmTerminationSweepDelayDays(): number {
    return this.settings.evm_termination_sweep_delay_days;
  }

  get evmTerminationAllowWaivers(): boolean {
    return this.settings.evm_termination_allow_waivers;
  }

  get lpRecommendedMinLiquidity(): number {
    return this.settings.lp_recommended_min_liquidity;
  }

  get maxAcquireAmountAda(): number {
    return this.settings.max_acquire_amount_ada || 10000000; // 10M ADA default
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

  get hiddenMainnetVaultIds(): string[] {
    return this.settings.hidden_mainnet_vault_ids || [];
  }

  isAddressWhitelistedForVaultCreation(address: string): boolean {
    const whitelist = this.vaultCreatorWhitelist;
    const now = new Date().getTime();
    const removeWhitelistAfter = new Date('2026-03-30T12:00:00-07:00').getTime(); // beginning on Monday March 30th @ 12pm PDT
    // If whitelist is empty, allow all addresses
    if (!whitelist || whitelist.length === 0 || now > removeWhitelistAfter) {
      return true;
    }
    return whitelist.includes(address);
  }

  // Governance fee getters
  get governanceFeeProposalStaking(): number {
    return this.settings.governance_fee_proposal_staking || 0;
  }

  get governanceFeeProposalDistribution(): number {
    return this.settings.governance_fee_proposal_distribution || 0;
  }

  get governanceFeeProposalTermination(): number {
    return this.settings.governance_fee_proposal_termination || 0;
  }

  get governanceFeeProposalBurning(): number {
    return this.settings.governance_fee_proposal_burning || 0;
  }

  get governanceFeeProposalMarketplaceAction(): number {
    return this.settings.governance_fee_proposal_marketplace_action || 0;
  }

  get governanceFeeProposalExpansion(): number {
    return this.settings.governance_fee_proposal_expansion || 0;
  }

  get governanceFeeProposalAssetWhitelistUpdate(): number {
    return this.settings.governance_fee_proposal_asset_whitelist_update || 0;
  }

  get governanceFeeVoting(): number {
    return this.settings.governance_fee_voting || 0;
  }

  // EVM governance fee getters (wei, as decimal strings)
  private evmFee(value: string | number | undefined): string {
    if (value === undefined || value === null || value === '') return '0';
    const asString = String(value);
    // Guard against a malformed settings edit reaching BigInt() downstream.
    if (!/^\d+$/.test(asString)) {
      this.logger.warn(`Invalid EVM governance fee value "${asString}" — treating as 0`);
      return '0';
    }
    return asString;
  }

  get governanceFeeProposalStakingEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_staking_evm);
  }

  get governanceFeeProposalDistributionEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_distribution_evm);
  }

  get governanceFeeProposalTerminationEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_termination_evm);
  }

  get governanceFeeProposalBurningEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_burning_evm);
  }

  get governanceFeeProposalMarketplaceActionEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_marketplace_action_evm);
  }

  get governanceFeeProposalExpansionEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_expansion_evm);
  }

  get governanceFeeProposalAssetWhitelistUpdateEvm(): string {
    return this.evmFee(this.settings.governance_fee_proposal_asset_whitelist_update_evm);
  }

  get governanceFeeVotingEvm(): string {
    return this.evmFee(this.settings.governance_fee_voting_evm);
  }

  get minVotingDuration(): number {
    // Environment-based: 5 min (preprod) / 1 day (mainnet)
    // Always use environment-based value (database setting is ignored for this)
    return this.isMainnet ? 86400000 : 300000;
  }

  get maxVotingDuration(): number {
    return this.settings.max_voting_duration || 259200000; // 3 days default
  }

  get minContributionDuration(): number {
    // Environment-based: 10 min (preprod) / 5 days (mainnet)
    // Always use environment-based value
    return this.isMainnet ? 432000000 : 600000;
  }

  get minAcquireWindowDuration(): number {
    // Environment-based: 10 min (preprod) / 5 days (mainnet)
    // Always use environment-based value
    return this.isMainnet ? 432000000 : 600000;
  }

  get minExpansionDuration(): number {
    // 1 day minimum for both environments
    return 86400000;
  }

  get priceMaxDeviationPercentNft(): number {
    const value = Number(this.settings.price_max_deviation_percent_nft);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SETTINGS.price_max_deviation_percent_nft;
  }

  get priceMaxDeviationPercentFt(): number {
    const value = Number(this.settings.price_max_deviation_percent_ft);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SETTINGS.price_max_deviation_percent_ft;
  }

  get priceMinAbsoluteMoveAda(): number {
    const value = Number(this.settings.price_min_absolute_move_ada);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SETTINGS.price_min_absolute_move_ada;
  }

  get priceMinAssetPriceForDeviationCheckAda(): number {
    const value = Number(this.settings.price_min_asset_price_for_deviation_check_ada);
    return Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_SETTINGS.price_min_asset_price_for_deviation_check_ada;
  }

  // Kill switch getters
  get vaultCreationEnabled(): boolean {
    return this.settings.vault_creation_enabled !== false; // Default true if not set
  }

  get contributionEnabled(): boolean {
    return this.settings.contribution_enabled !== false; // Default true if not set
  }

  get acquireEnabled(): boolean {
    return this.settings.acquire_enabled !== false; // Default true if not set
  }

  get governanceEnabled(): boolean {
    return this.settings.governance_enabled !== false; // Default true if not set
  }

  /**
   * Get the fee for a specific proposal type
   * @param proposalType - The type of proposal
   * @returns Fee amount in lovelace
   */
  getGovernanceFeeForProposalType(proposalType: string): number {
    switch (proposalType) {
      case 'staking':
        return this.governanceFeeProposalStaking;
      case 'distribution':
        return this.governanceFeeProposalDistribution;
      case 'termination':
        return this.governanceFeeProposalTermination;
      case 'burning':
        return this.governanceFeeProposalBurning;
      case 'marketplace_action':
        return this.governanceFeeProposalMarketplaceAction;
      case 'buy_sell':
        return this.governanceFeeProposalMarketplaceAction;
      case 'expansion':
        return this.governanceFeeProposalExpansion;
      case 'acquire_expansion':
        return this.governanceFeeProposalExpansion;
      case 'asset_whitelist_update':
        return this.governanceFeeProposalAssetWhitelistUpdate;
      default:
        this.logger.warn(`Unknown proposal type: "${proposalType}" - returning 0`);
        return 0;
    }
  }

  /**
   * Get the EVM fee for a specific proposal type.
   * Mirrors getGovernanceFeeForProposalType, including the buy_sell and
   * acquire_expansion aliases.
   * @returns Fee amount in wei, as a decimal string
   */
  getGovernanceFeeForProposalTypeEvm(proposalType: string): string {
    switch (proposalType) {
      case 'staking':
        return this.governanceFeeProposalStakingEvm;
      case 'distribution':
        return this.governanceFeeProposalDistributionEvm;
      case 'termination':
        return this.governanceFeeProposalTerminationEvm;
      case 'burning':
        return this.governanceFeeProposalBurningEvm;
      case 'marketplace_action':
        return this.governanceFeeProposalMarketplaceActionEvm;
      case 'buy_sell':
        return this.governanceFeeProposalMarketplaceActionEvm;
      case 'expansion':
        return this.governanceFeeProposalExpansionEvm;
      case 'acquire_expansion':
        return this.governanceFeeProposalExpansionEvm;
      case 'asset_whitelist_update':
        return this.governanceFeeProposalAssetWhitelistUpdateEvm;
      default:
        this.logger.warn(`Unknown proposal type: "${proposalType}" - returning 0`);
        return '0';
    }
  }
}
