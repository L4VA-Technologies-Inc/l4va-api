// step 1
export enum VaultType {
  single = 'single',
  multi = 'multi',
  ctn = 'ctn',
  cnt = 'cnt',
}

export enum VaultPrivacy {
  // Represent an enum setup by L4VA (0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE) in SC
  private = 'private',
  public = 'public',
  semiPrivate = 'semi-private',
}

export enum VaultPresetType {
  simple = 'simple',
  contributors = 'contributors',
  acquirers = 'acquirers',
  acquirers_50 = 'acquirers_50',
  custom = 'custom',
  acquire_only = 'acquire_only',
  advanced = 'advanced',
}

// step 2
export enum ValueMethod {
  // Enum 0: 'FIXED' 1: 'LBE' in SC
  lbe = 'lbe',
  fixed = 'fixed',
}
export enum ContributionWindowType {
  custom = 'custom',
  uponVaultLaunch = 'upon-vault-launch',
}

// step 3

export enum InvestmentWindowType {
  custom = 'custom',
  uponAssetWindowClosing = 'upon-asset-window-closing',
}

// step 4
export enum TerminationType {
  dao = 'dao',
  programmed = 'programmed',
}

export enum VaultStatus {
  draft = 'draft',
  created = 'created',
  published = 'published',
  contribution = 'contribution',
  acquire = 'acquire',
  investment = 'investment',
  locked = 'locked',
  failed = 'failed',
  burned = 'burned',
  govern = 'govern',
  terminating = 'terminating',
  expansion = 'expansion',
  acquire_expansion = 'acquire_expansion',
}

/** Vault statuses included in search results */
export const VAULT_SEARCH_STATUSES: VaultStatus[] = [
  VaultStatus.published,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
  VaultStatus.contribution,
  VaultStatus.acquire,
  VaultStatus.locked,
  VaultStatus.terminating,
  VaultStatus.burned,
];

/** Vaults that owner or admin may cancel (upcoming + contribution), subject to other checks. */
export const VAULT_CANCELLABLE_STATUSES: VaultStatus[] = [VaultStatus.published, VaultStatus.contribution];

/**
 * Vault statuses where users own VT (Vault Token) tokens
 * Used for: TVL and gains calculations based on VT token holdings
 * - Users receive VT tokens after contribution/acquire phases complete
 * - TVL calculated as: user_vt_balance / total_vt_supply * vault_tvl
 * - Gains calculated as: current_tvl - initial_tvl (based on VT ownership %)
 */
export const VAULT_STATUSES_WITH_VT_TOKENS: VaultStatus[] = [
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
];

/**
 * Vault statuses where users have contributed assets but don't own VT tokens yet
 * Used for: Asset value calculations during active contribution/acquisition phases
 * - Users' TVL = sum of their contributed assets' current market values
 * - No gains calculated (users can still cancel contributions)
 * - VT tokens will be distributed when vault transitions to locked/expansion
 */
export const VAULT_STATUSES_WITHOUT_VT_TOKENS: VaultStatus[] = [VaultStatus.contribution, VaultStatus.acquire];

/**
 * Active vault statuses that require periodic asset price updates
 * Used for: Scheduled tasks that update asset prices and recalculate vault TVL
 * - Includes both pre-lock phases (contribution, acquire) and post-lock phases
 * - Asset prices fetched from DexHunter (FTs) and WayUp (NFTs)
 * - TVL recalculated after price updates
 */
export const VAULT_STATUSES_ACTIVE: VaultStatus[] = [
  VaultStatus.contribution,
  VaultStatus.acquire,
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
];

/**
 * Vault statuses included in platform TVL (Total Value Locked) statistics
 * Used for: Platform-wide TVL reporting and user portfolio calculations
 * - Only includes vaults where assets are locked and VT tokens exist
 * - Excludes contribution/acquire phases (assets not yet locked)
 * - Used for homepage statistics and user TVL dashboards
 */
export const VAULT_STATUSES_WITH_TVL: VaultStatus[] = [
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
];

/**
 * Vault statuses that may have liquidity pools (LP) for their VT tokens
 * Used for: Market statistics updates and LP-based gains calculations
 * - Checks DexHunter for LP liquidity across all DEXs
 * - Fetches OHLCV price data from TapTools if LP exists
 * - LP gains calculated using historical price data (first open → latest close)
 */
export const VAULT_STATUSES_WITH_POTENTIAL_LP: VaultStatus[] = [
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
];

/**
 * Vault statuses included in platform statistics by stage (for homepage charts)
 * Used for: Breaking down vaults by their current lifecycle stage
 * - Includes active and completed states (contribution → burned)
 * - Excludes draft/created/published (not yet active)
 * - Burned status represents permanently terminated vaults
 */
export const VAULT_STATUSES_FOR_STAGE_STATS: VaultStatus[] = [
  VaultStatus.contribution,
  VaultStatus.acquire,
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
  VaultStatus.burned,
];

/**
 * Vault statuses included in total contributed value calculations
 * Used for: Tracking lifetime value contributed across all vault phases
 * - Includes all states where assets were contributed (successful or not)
 * - Failed vaults still count toward historical contribution totals
 * - Used for platform-wide metrics and reporting
 */
export const VAULT_STATUSES_FOR_CONTRIBUTED_STATS: VaultStatus[] = [
  VaultStatus.contribution,
  VaultStatus.acquire,
  VaultStatus.locked,
  VaultStatus.expansion,
  VaultStatus.acquire_expansion,
  VaultStatus.failed,
];

// Mapping for smart contract vault status
export enum SmartContractVaultStatus {
  PENDING = 0,
  OPEN = 1,
  SUCCESSFUL = 2,
  CANCELLED = 3,
}

export interface ApplyParamsResult {
  addresses: {
    [scriptHash: string]: {
      hex: string;
      bech32: string;
    };
  };
  preloadedScript: {
    type: string;
    blueprint: {
      preamble: {
        id: number;
        title: string;
        license: string;
        version: string;
        clientId: string;
        compiler: {
          name: string;
          version: string;
        };
        createdAt: string;
        updatedAt: string;
        description: string;
        plutusVersion: string;
      };
      validators: Array<{
        ref: string;
        hash: string;
        datum?: {
          title: string;
          schema: {
            $ref: string;
          };
        };
        title: string;
        redeemer?: {
          title?: string;
          schema: any;
        };
        description: string | null;
        compiledCode: string;
        parameters?: any;
      }>;
    };
    validatorRefs?: {
      [hash: string]: {
        index: number;
        txHash: string;
      };
    };
  };
  definitions?: Record<string, any>;
}

export enum VaultFailureReason {
  ASSET_THRESHOLD_VIOLATION = 'asset_threshold_violation',
  ACQUIRE_THRESHOLD_NOT_MET = 'acquire_threshold_not_met',
  NO_CONTRIBUTIONS = 'no_contributions',
  NO_CONFIRMED_TRANSACTIONS = 'no_confirmed_transactions',
  MANUAL_CANCELLATION = 'manual_cancellation',
  INSUFFICIENT_LP_LIQUIDITY = 'insufficient_lp_liquidity',
}
