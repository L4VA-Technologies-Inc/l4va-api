export enum VaultType {
  SINGLE = 'single',
  MULTI = 'multi',
  CTN = 'ctn',
  CNT = 'cnt',
}

export enum VaultPrivacy {
  PUBLIC = 'public',
  PRIVATE = 'private',
  SEMI_PRIVATE = 'semi-private',
}

export enum ValueMethod {
  LBE = 'lbe',
  FIXED = 'fixed',
}

export enum ContributionWindowType {
  CUSTOM = 'custom',
  UPON_VAULT_LAUNCH = 'upon-vault-launch',
}

export enum InvestmentWindowType {
  CUSTOM = 'custom',
  UPON_ASSET_WINDOW_CLOSING = 'upon-asset-window-closing',
}

export enum TerminationType {
  DAO = 'dao',
  PROGRAMMED = 'programmed',
}

export enum VaultStatus {
  DRAFT = 'draft',
  CREATED = 'created',
  PUBLISHED = 'published',
  CONTRIBUTION = 'contribution',
  ACQUIRE = 'acquire',
  INVESTMENT = 'investment',
  LOCKED = 'locked',
  GOVERNANCE = 'governance',
  FAILED = 'failed',
  EXPANSION = 'expansion',
  ACQUIRE_EXPANSION = 'acquire_expansion',
}

export enum ProposalType {
  STAKING = 'staking',
  DISTRIBUTION = 'distribution',
  TERMINATION = 'termination',
  BURNING = 'burning',
  BUY_SELL = 'buy_sell',
  MARKETPLACE_ACTION = 'marketplace_action',
  EXPANSION = 'expansion',
  ASSET_WHITELIST_UPDATE = 'asset_whitelist_update',
  ACQUIRE_EXPANSION = 'acquire_expansion',
}

export const ProposalTypeLabels = {
  [ProposalType.STAKING]: 'Staking',
  [ProposalType.DISTRIBUTION]: 'Distribution',
  [ProposalType.TERMINATION]: 'Termination',
  [ProposalType.BURNING]: 'Burning',
  [ProposalType.BUY_SELL]: 'Buy/Sell',
  [ProposalType.MARKETPLACE_ACTION]: 'Market Actions',
  [ProposalType.EXPANSION]: 'Vault Expansion',
  [ProposalType.ASSET_WHITELIST_UPDATE]: 'Update Asset Whitelist',
  [ProposalType.ACQUIRE_EXPANSION]: 'Acquire Expansion',
};

export enum ClaimStatus {
  AVAILABLE = 'available',
  PENDING = 'pending',
  CLAIMED = 'claimed',
}

export enum ChainType {
  CARDANO = 'cardano',
  ROBINHOOD = 'robinhood',
}

export const ChainTypeLabels: Record<ChainType, string> = {
  [ChainType.CARDANO]: 'Cardano',
  [ChainType.ROBINHOOD]: 'Robinhood',
};

// Type interfaces based on @Expose annotations
export interface IUser {
  id: string;
  username?: string;
  walletAddress: string;
  email?: string;
  biography?: string;
  twitterUsername?: string;
  discordUsername?: string;
  profileImage?: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  socialLinks?: ILink[];
  claims?: IClaim[];
}

export interface IVault {
  id: string;
  name: string;
  type?: VaultType;
  privacy?: VaultPrivacy;
  description?: string;
  valueMethod?: ValueMethod;
  contractAddress?: string;
  policyId?: string;
  assetVaultName?: string;
  valuationCurrency?: string;
  valuationAmount?: number;
  contributionOpenWindowType?: ContributionWindowType;
  contributionOpenWindowTime?: number;
  contributionDuration?: number;
  acquireWindowDuration?: number;
  acquireOpenWindowType?: InvestmentWindowType;
  acquireOpenWindowTime?: number;
  tokensForAcquires?: number;
  acquireReserve?: number;
  maxContributeAssets?: number;
  liquidityPoolContribution?: number;
  vaultStatus?: VaultStatus;
  createdAt: string;
  updatedAt: string;
  owner?: IUser;
  tags?: ITag[];
  socialLinks?: ILink[];
  assetsWhitelist?: IAssetsWhitelist[];
  contributorWhitelist?: IContributorWhitelist[];
  isOfficialPartner?: boolean;
}

export interface ITag {
  id: string;
  name: string;
  vaults?: IVault[];
}

export interface ILink {
  id?: string;
  url: string;
  name: string;
  vaultId?: string;
  userId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IAssetsWhitelist {
  id?: string;
  policyId: string;
  countCapMin?: number;
  countCapMax?: number;
  valuationMethod?: 'market' | 'custom';
  customPriceAda?: number;
  updatedAt?: string;
  createdAt?: string;
}

export interface IContributorWhitelist {
  id?: string;
  walletAddress: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface IClaim {
  id: string;
  userId?: string;
  vaultId?: string;
  type: string;
  status: ClaimStatus;
  amount: number;
  txHash?: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

// Request/Response types
export interface VaultResponse extends IVault {
  vaultImage?: string;
  bannerImage?: string;
  ftTokenImg?: string;
  terminationType?: TerminationType;
  timeElapsedIsEqualToTime?: number;
  vaultAppreciation?: number;
  creationThreshold?: number;
  startThreshold?: number;
  voteThreshold?: number;
  executionThreshold?: number;
  cosigningThreshold?: number;
}

export interface VaultShortResponse {
  id: string;
  name: string;
  description?: string;
  tvl?: number;
  totalValueAda?: number;
  totalValueUsd?: number;
  baseAllocation?: number;
  total?: number;
  invested?: number;
  privacy: VaultPrivacy;
  phaseStartTime: string | null;
  phaseEndTime: string | null;
  timeRemaining: number;
  vaultImage?: string;
  bannerImage?: string;
  vaultStatus: VaultStatus;
  socialLinks?: ILink[];
  ftTokenImg?: string;
  vaultTokenTicker?: string;
  isOfficialPartner?: boolean;
  chainType?: ChainType;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    totalItems: number;
    itemCount: number;
    itemsPerPage: number;
    totalPages: number;
    currentPage: number;
  };
}

// Form types
export interface CreateVaultFormData {
  name: string;
  type: VaultType;
  privacy: VaultPrivacy;
  description?: string;
  isExpandableAssetWhitelist?: boolean;
  vaultImage: string;
  socialLinks: ILink[];
  valueMethod: ValueMethod;
  contributionOpenWindowType: ContributionWindowType;
  contributionOpenWindowTime?: number;
  contributionDuration: number;
  acquireWindowDuration: number;
  acquireOpenWindowType: InvestmentWindowType;
  acquireOpenWindowTime?: number;
  tokensForAcquires: number;
  acquireReserve: number;
  liquidityPoolContribution: number;
  ftTokenImg: string;
  ftTokenSupply: number;
  terminationType: TerminationType;
  timeElapsedIsEqualToTime?: number;
  vaultAppreciation?: number;
  creationThreshold: number;
  startThreshold: number;
  voteThreshold: number;
  executionThreshold: number;
  cosigningThreshold: number;
  assetsWhitelist: IAssetsWhitelist[];
  acquirerWhitelist?: IContributorWhitelist[];
  contributorWhitelist?: IContributorWhitelist[];
}
