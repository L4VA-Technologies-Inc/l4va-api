import { ApiProperty } from '@nestjs/swagger';

import { DtoRepresent } from '../../../decorators/dto-represents.decorator';
import {
  VaultPrivacy,
  VaultStatus,
  VaultType,
  ValueMethod,
  ContributionWindowType,
  InvestmentWindowType,
  TerminationType,
  VaultFailureReason,
} from '../../../types/vault.types';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { User } from '@/database/user.entity';

export class VaultShortResponse {
  @ApiProperty({ description: 'Unique identifier of the vault' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  id: string;

  @ApiProperty({ description: 'Name of the vault' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  name: string;

  @ApiProperty({ description: 'Description of the vault', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  description?: string;

  @ApiProperty({
    description: 'Total value of locked vaults in USD',
    example: 1250000,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  totalValueUsd: number;

  @ApiProperty({
    description: 'Total value of locked vaults in ADA',
    example: 3500000,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  totalValueAda: number;

  @ApiProperty({ description: 'Tvl', required: true })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: true,
  })
  invested?: number;

  @ApiProperty({ description: 'Privacy setting of the vault', enum: VaultPrivacy })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  privacy: VaultPrivacy;

  @ApiProperty({ description: 'Timestamp when current phase starts', required: true })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  phaseStartTime: string;

  @ApiProperty({ description: 'Timestamp when current phase ends', required: true })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  phaseEndTime: string;

  @ApiProperty({ description: 'Time remaining in current phase in milliseconds', required: true })
  @DtoRepresent({
    transform: ({ obj }) => {
      if (!obj.phaseEndTime) return null;
      const now = new Date();
      const endTime = new Date(obj.phaseEndTime);
      const diff = endTime.getTime() - now.getTime();
      return diff > 0 ? diff : 0;
    },
    expose: true,
  })
  timeRemaining: number;

  @ApiProperty({ description: 'Vault image', required: true })
  @DtoRepresent({
    transform: ({ value }) => (value ? value.url : null),
    expose: true,
  })
  vaultImage?: FileEntity;

  @ApiProperty({ description: 'Status of the vault', enum: VaultStatus })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  vaultStatus: VaultStatus;

  @ApiProperty({ description: 'Social links', type: [LinkEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'socialLinks' },
  })
  socialLinks?: LinkEntity[];

  @ApiProperty({ description: 'Tags', type: [String], required: false, example: ['NFT', 'Art', 'Gaming'] })
  @DtoRepresent({
    transform: ({ value }) => value?.map(tag => tag.name) || [],
    expose: true,
  })
  tags?: string[];

  @ApiProperty({ description: 'Fractional token image ' })
  @DtoRepresent({
    transform: ({ value }) => (value ? value.url : null),
    expose: true,
  })
  ftTokenImg: FileEntity;

  @ApiProperty({ description: 'VT token ticker', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  vaultTokenTicker?: string;
}

export class VaultFullResponse extends VaultShortResponse {
  @ApiProperty({ description: 'Type of the vault', enum: VaultType })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  type: VaultType;

  @ApiProperty({ description: 'Hash of publication tx' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'publicationHash' },
  })
  publicationHash: string;

  @ApiProperty({ description: 'Required values cost for success acquire phase in ada' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'requireReservedCostAda' },
  })
  requireReservedCostAda: number;

  @ApiProperty({ description: 'Count of contributed assets  ' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'assetsCount' },
  })
  assetsCount: number;

  @ApiProperty({ description: 'Count of unique vault members (users who contributed assets or acquired tokens)' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'vaultMembersCount' },
  })
  vaultMembersCount: number;

  @ApiProperty({ description: 'Response with list of assets prices  ' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'assetsPrices' },
  })
  assetsPrices?: any;

  @ApiProperty({ description: 'Max count of contributed count ' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'maxContributeAssets' },
  })
  maxContributeAssets: number;

  @ApiProperty({ description: 'Fdv in USD value' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'fdvUsd' },
  })
  fdvUsd: number;

  @ApiProperty({ description: 'Required values cost for success acquire phase in usd' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'requireReservedCostUsd' },
  })
  requireReservedCostUsd: number;

  @ApiProperty({ description: 'Recommended minimum liquidity for LP in ADA' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'lpMinLiquidityAda' },
  })
  lpMinLiquidityAda: number;

  @ApiProperty({ description: 'Recommended minimum liquidity for LP in USD' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'lpMinLiquidityUsd' },
  })
  lpMinLiquidityUsd: number;

  @ApiProperty({
    description:
      'Estimated LP liquidity in ADA if vault reaches 100% of required acquire reserve (based on vault configuration: LP%, FDV, and asset distribution)',
  })
  @DtoRepresent({
    transform: false,
    expose: { name: 'projectedLpAdaAmount' },
  })
  projectedLpAdaAmount: number;

  @ApiProperty({
    description:
      'Estimated LP liquidity in USD if vault reaches 100% of required acquire reserve (based on vault configuration: LP%, FDV, and asset distribution)',
  })
  @DtoRepresent({
    transform: false,
    expose: { name: 'projectedLpUsdAmount' },
  })
  projectedLpUsdAmount: number;

  @ApiProperty({ description: 'Protocol fee for contributors in lovelace', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolContributorsFeeLovelace' },
  })
  protocolContributorsFeeLovelace?: number;

  @ApiProperty({ description: 'Protocol fee for contributors in ADA', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolContributorsFeeAda' },
  })
  protocolContributorsFeeAda?: number;

  @ApiProperty({ description: 'Protocol fee for contributors in USD', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolContributorsFeeUsd' },
  })
  protocolContributorsFeeUsd?: number;

  @ApiProperty({ description: 'Protocol fee for acquirers in lovelace', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolAcquiresFeeLovelace' },
  })
  protocolAcquiresFeeLovelace?: number;

  @ApiProperty({ description: 'Protocol fee for acquirers in ADA', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolAcquiresFeeAda' },
  })
  protocolAcquiresFeeAda?: number;

  @ApiProperty({ description: 'Protocol fee for acquirers in USD', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolAcquiresFeeUsd' },
  })
  protocolAcquiresFeeUsd?: number;

  @ApiProperty({ description: 'Whether protocol fees are enabled', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'protocolEnabled' },
  })
  protocolEnabled?: boolean;

  @ApiProperty({
    description: 'Indicates whether the user can create proposals for this vault',
    type: Boolean,
    default: false,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  canCreateProposal: boolean;

  @ApiProperty({
    description: 'Indicates whether the user can acquire from this vault',
    type: Boolean,
    default: true,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  isWhitelistedAcquirer: boolean;

  @ApiProperty({
    description: 'Indicates whether the user can contribute to this vault',
    type: Boolean,
    default: true,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  isWhitelistedContributor: boolean;

  @ApiProperty({
    description: 'Indicates whether the user can see a chat',
    type: Boolean,
    default: false,
  })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  isChatVisible: boolean;

  @ApiProperty({ description: 'Valuation type', enum: ValueMethod, required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'valueMethod' },
  })
  valueMethod?: ValueMethod;

  @ApiProperty({ description: 'Contract address', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'contractAddress' },
  })
  contractAddress: string;

  @ApiProperty({ description: 'Valuation currency', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'valuationCurrency' },
  })
  valuationCurrency?: string;

  @ApiProperty({ description: 'Policy ID', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'policyId' },
  })
  policyId?: string;

  @ApiProperty({ description: 'Valuation amount', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'valuationAmount' },
  })
  valuationAmount?: number;

  @ApiProperty({ description: 'Contribution duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'contributionDuration' },
  })
  contributionDuration?: number;

  @ApiProperty({ description: 'Investment window duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'acquireWindowDuration' },
  })
  acquireWindowDuration?: number;

  @ApiProperty({ description: 'Time elapsed duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'expansionDuration' },
  })
  expansionDuration?: number;

  @ApiProperty({ description: 'Time elapsed duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'timeElapsedIsEqualToTime' },
  })
  timeElapsedIsEqualToTime?: number;

  @ApiProperty({ description: 'Contribution window type', enum: ContributionWindowType })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  contributionOpenWindowType: ContributionWindowType;

  @ApiProperty({ description: 'Contribution window time' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  contributionOpenWindowTime: string;

  @ApiProperty({ description: 'Investment window type', enum: InvestmentWindowType })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  acquireOpenWindowType: InvestmentWindowType;

  @ApiProperty({ description: 'Investment window time' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  acquireOpenWindowTime: string;

  @ApiProperty({ description: 'Number of assets offered' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  tokensForAcquires: number;

  @ApiProperty({ description: 'VT acquire reserve' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  acquireReserve: number;

  @ApiProperty({ description: 'Liquidity pool contribution' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  liquidityPoolContribution: number;

  @ApiProperty({ description: 'VT token supply' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  ftTokenSupply: number;

  @ApiProperty({ description: 'Fully diluted valuation in ADA' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  fdv: number;

  @ApiProperty({ description: 'FDV TVL' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  fdvTvl: number;

  @ApiProperty({ description: 'Vault Token (VT) price in ADA', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'vtPrice' },
  })
  vtPrice?: number;

  @ApiProperty({ description: 'VT gains' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  vtGains: number;

  @ApiProperty({ description: 'VT token ticker' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  vaultTokenTicker: string;

  @ApiProperty({ description: 'VT token decimals' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  ftTokenDecimals: number;

  @ApiProperty({ description: 'Termination type', enum: TerminationType })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  terminationType: TerminationType;

  @ApiProperty({ description: 'Vault appreciation' })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  vaultAppreciation: number;

  @ApiProperty({ description: 'Creation threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  creationThreshold?: number;

  @ApiProperty({ description: 'Start threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  startThreshold?: number;

  @ApiProperty({ description: 'Vote threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  voteThreshold?: number;

  @ApiProperty({ description: 'Execution threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  executionThreshold?: number;

  @ApiProperty({ description: 'Cosigning threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  cosigningThreshold?: number;

  @ApiProperty({ description: 'Gains in ADA', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'gainsAda' },
  })
  gainsAda?: number;

  @ApiProperty({ description: 'Gains in USD', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? Number(value) : null),
    expose: { name: 'gainsUsd' },
  })
  gainsUsd?: number;

  @ApiProperty({ description: 'Assets whitelist', type: [AssetsWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  assetsWhitelist?: AssetsWhitelistEntity[];

  @ApiProperty({ description: 'Acquirer whitelist', type: [AcquirerWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  acquirerWhitelist?: AcquirerWhitelistEntity[];

  @ApiProperty({ description: 'Contributor whitelist', type: [ContributorWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  contributorWhitelist?: ContributorWhitelistEntity[];

  @ApiProperty({ description: 'Assets', type: [Asset], required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  assets?: Asset[];

  @ApiProperty({ description: 'Acquirer whitelist CSV file', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  acquirerWhitelistCsv?: FileEntity;

  @ApiProperty({ description: 'Contribution phase start time', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: {
      name: 'contributionPhaseStart',
    },
  })
  contributionPhaseStart?: string;

  @ApiProperty({ description: 'Investment phase start time', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  acquirePhaseStart?: string;

  @ApiProperty({ description: 'Expansion phase start time', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  expansionPhaseStart?: string;

  @ApiProperty({ description: 'Locked at time', required: false })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  lockedAt?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  updatedAt: string;

  @ApiProperty({ description: 'Count view', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  countView: number;

  @ApiProperty({ description: 'Expansion asset count', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionAssetsCount' },
  })
  expansionAssetsCount?: number;

  @ApiProperty({ description: 'Expansion asset max limit', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionAssetMax' },
  })
  expansionAssetMax?: number;

  @ApiProperty({ description: 'Whether expansion has no asset limit', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionNoMax' },
  })
  expansionNoMax?: boolean;

  @ApiProperty({ description: 'Expansion assets grouped by policy', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionAssetsByPolicy' },
  })
  expansionAssetsByPolicy?: Array<{ policyId: string; quantity: number }>;

  @ApiProperty({
    description: 'Expansion whitelisted collections with names',
    required: false,
    type: 'array',
    items: {
      type: 'object',
      properties: {
        policyId: { type: 'string' },
        collectionName: { type: 'string', nullable: true },
      },
    },
  })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionWhitelist' },
  })
  expansionWhitelist?: Array<{ policyId: string; collectionName: string | null }>;

  @ApiProperty({ description: 'Expansion price type (limit or market)', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionPriceType' },
  })
  expansionPriceType?: 'limit' | 'market';

  @ApiProperty({ description: 'Expansion limit price (ADA per VT)', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'expansionLimitPrice' },
  })
  expansionLimitPrice?: number;

  @ApiProperty({ description: 'Owner of the vault', type: () => User })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  owner: User;

  @ApiProperty({ description: 'Failure reason', required: false })
  @DtoRepresent({
    transform: false,
    expose: true,
  })
  failureReason: VaultFailureReason;
}

export class VaultAcquireResponse {
  @ApiProperty({ description: 'Unique identifier of the vault' })
  id: string;

  @ApiProperty({ description: 'Vault name' })
  name: string;

  @ApiProperty({ description: 'Privacy setting of the vault' })
  privacy: string;

  @ApiProperty({ description: 'Acquire window duration in ms' })
  acquire_window_duration: number;

  @ApiProperty({ description: 'Total assets cost in USD' })
  total_assets_cost_usd: number;

  @ApiProperty({ description: 'Total assets cost in ADA' })
  total_assets_cost_ada: number;

  @ApiProperty({ description: 'Vault status' })
  vault_status: string;

  @ApiProperty({ description: 'Acquire phase start timestamp' })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  acquire_phase_start: string;

  @ApiProperty({ description: 'Time left until end of acquire phase' })
  @DtoRepresent({
    transform: ({ value }) => (value ? new Date(value).toISOString() : null),
    expose: true,
  })
  timeLeft: string;
}
