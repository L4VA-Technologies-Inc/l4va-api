/**
 * Base metadata interface for all claim types
 */
export interface BaseClaimMetadata {
  /** Error message if claim processing failed */
  error?: string;
  /** Additional descriptive information */
  notes?: string;
}

/**
 * Metadata for CONTRIBUTOR claims
 * Used when contributors receive VT tokens and ADA
 * Note: Actual amounts stored in entity columns (amount, lovelace_amount)
 */
export interface ContributorClaimMetadata extends BaseClaimMetadata {
  /** True if vault has no acquirers (100% contributors) */
  noAcquirers?: boolean;
}

/**
 * Metadata for CANCELLATION claims
 * Used when vault fails and assets/ADA need to be returned
 * Note: Original tx hash available via transaction relation
 */
export interface CancellationClaimMetadata extends BaseClaimMetadata {
  /** Type of transaction being cancelled */
  transactionType: 'contribution' | 'acquisition' | 'expansion_refund';
  /** Reason for vault failure/cancellation */
  failureReason: string;
  /** Output index for the UTXO to claim (default: 0) */
  outputIndex?: number;
  /** Detailed asset information for contributions */
  assets?: Array<{
    id: string;
    policyId: string;
    assetId: string;
    quantity: number | string;
    type: string;
  }>;
  /** ID of expansion proposal (for expansion refunds) */
  expansionProposalId?: string;
  /** Required minimum that wasn't met (for expansion refunds) */
  requiredMin?: number;
}

/**
 * Metadata for TERMINATION claims
 * Used when vault is terminated and VT holders burn tokens for ADA/FT distribution
 * Note: VT and ADA amounts also stored in entity columns (amount, lovelace_amount)
 */
export interface TerminationClaimMetadata extends BaseClaimMetadata {
  /** User's wallet address */
  address: string;
  /** Amount of VT tokens user needs to burn */
  vtAmount: string;
  /** Amount of ADA user will receive (in lovelace) */
  adaAmount: string;
  /** Fungible token shares user will receive */
  ftShares?: Array<{
    policyId: string;
    assetId: string;
    quantity: string;
    name?: string;
  }>;
  /** True if vault doesn't have enough ADA for distribution */
  noAdaDistribution?: boolean;
}

/**
 * Metadata for LP (Liquidity Pool) claims
 * Used when creating liquidity pool on VyFi
 */
export interface LpClaimMetadata extends BaseClaimMetadata {
  /** Amount of VT tokens for LP */
  vtAmount?: number;
  /** Amount of ADA for LP (in lovelace) */
  adaAmount?: number;
  /** VyFi pool transaction hash */
  poolTxHash?: string;
  /** LP token quantity received */
  lpTokens?: string;
}

/**
 * Metadata for DISTRIBUTION claims
 * Used for general token/ADA distributions to users
 * Note: VT and ADA amounts stored in entity columns (amount, lovelace_amount)
 * Note: Distribution tx hash available via distribution_tx_id FK to Transaction entity
 */
export interface DistributionClaimMetadata extends BaseClaimMetadata {
  /** Recipient wallet address (required) */
  address: string;
  /** Batch processing information */
  batchId?: string;
}

/**
 * Metadata for L4VA token reward claims
 * Used for monthly L4VA token distributions to vault creators and VT holders
 */
export interface L4vaClaimMetadata extends BaseClaimMetadata {
  /** Role of the recipient: AU (Asset Utilizer/Creator) or AC/VI (Asset Contributors/Vault Investors) */
  l4va_role: 'AU' | 'AC/VI';
  /** Month number of vesting (1-12) */
  month: number;
  /** Total months in vesting period */
  totalMonths: number;
  /** VT amount held (for AC/VI claims) */
  vtAmount?: string;
  /** Percentage of VT holdings (for AC/VI claims) */
  vtPercentage?: number;
  /** Snapshot ID used for calculating distribution */
  snapshot_id?: string;
}

/**
 * Metadata for EXPANSION claims
 * Used when users contribute during expansion phase and receive VT tokens
 */
export interface ExpansionClaimMetadata extends BaseClaimMetadata {
  /** ID of the expansion proposal that created this claim */
  expansionProposalId: string;
  /** Pricing method used: 'limit' or 'market' */
  pricingMethod: 'limit' | 'market';
  /** Limit price in VT per asset (if using limit pricing) */
  limitPrice?: number;
  /** Market price in ADA per VT (if using market pricing) */
  marketPrice?: number;
  /** Number of assets contributed */
  assetCount: number;
  /** Total ADA value of contributed assets */
  assetValueAda?: number;
  /** Timestamp when claim was calculated */
  calculatedAt: string;
  /** Assets contributed in this expansion contribution */
  assets: Array<{
    id?: string;
    policyId: string;
    assetId: string;
    name?: string;
    quantity: number;
  }>;
}

/**
 * Union type for all claim metadata types
 * Use this for type-safe access to claim metadata based on claim type
 */
export type ClaimMetadata =
  | ContributorClaimMetadata
  | CancellationClaimMetadata
  | TerminationClaimMetadata
  | LpClaimMetadata
  | DistributionClaimMetadata
  | L4vaClaimMetadata
  | ExpansionClaimMetadata
  | BaseClaimMetadata;

/**
 * Type guard to check if metadata is CancellationClaimMetadata
 */
export function isCancellationMetadata(metadata: unknown): metadata is CancellationClaimMetadata {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'transactionType' in metadata &&
    typeof (metadata as CancellationClaimMetadata).transactionType === 'string' &&
    typeof (metadata as CancellationClaimMetadata).failureReason === 'string'
  );
}

/**
 * Type guard to check if metadata is TerminationClaimMetadata
 */
export function isTerminationMetadata(metadata: unknown): metadata is TerminationClaimMetadata {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'address' in metadata &&
    typeof (metadata as TerminationClaimMetadata).address === 'string' &&
    typeof (metadata as TerminationClaimMetadata).vtAmount === 'string' &&
    typeof (metadata as TerminationClaimMetadata).adaAmount === 'string'
  );
}

/**
 * Type guard to check if metadata is DistributionClaimMetadata
 */
export function isDistributionMetadata(metadata: unknown): metadata is DistributionClaimMetadata {
  return (
    metadata !== null &&
    typeof metadata === 'object' &&
    'address' in metadata &&
    typeof (metadata as DistributionClaimMetadata).address === 'string'
  );
}
