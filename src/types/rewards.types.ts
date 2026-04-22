export enum RewardActivityType {
  ASSET_CONTRIBUTION = 'asset_contribution',
  TOKEN_ACQUIRE = 'token_acquire',
  EXPANSION_ASSET_CONTRIBUTION = 'expansion_asset_contribution',
  EXPANSION_TOKEN_PURCHASE = 'expansion_token_purchase',
  LP_POSITION_UPDATE = 'lp_position_update',
  WIDGET_SWAP = 'widget_swap',
  GOVERNANCE_PROPOSAL = 'governance_proposal',
  GOVERNANCE_VOTE = 'governance_vote',
}

export enum EpochStatus {
  ACTIVE = 'active',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
}

export enum VestingPositionStatus {
  ACTIVE = 'active',
  /** Vesting period ended and finalized. unlocked_amount may be < vested_amount due to hold_factor. */
  FINALIZED = 'fully_unlocked',
  /** Cancelled due to low hold_factor at maturity. Already unlocked amount remains claimable. */
  CANCELLED = 'cancelled',
}

export enum LpPoolType {
  VT_ADA = 'vt_ada',
  VT_USDCX = 'vt_usdcx',
}

export enum RewardClaimStatus {
  AVAILABLE = 'available',
  CLAIMED = 'claimed',
}

export const REWARDS_CONSTANTS = {
  /** Weekly emission in L4VA base units (1M L4VA) */
  WEEKLY_EMISSION: 1_000_000,

  /** Program duration in weeks */
  TOTAL_WEEKS: 200,

  /** Creator pool share */
  CREATOR_SHARE: 0.2,

  /** Participant pool share */
  PARTICIPANT_SHARE: 0.8,

  /** Creator pool per epoch */
  CREATOR_POOL: 200_000,

  /** Participant pool per epoch */
  PARTICIPANT_POOL: 800_000,

  /** Maximum wallet reward share per epoch (5%) */
  MAX_WALLET_SHARE: 0.05,

  /** Maximum reward per wallet per epoch (800k * 5%)  */
  MAX_WALLET_REWARD: 40_000,

  /** Vesting immediate portion */
  VESTING_IMMEDIATE_RATIO: 0.5,

  /** Vesting locked portion */
  VESTING_LOCKED_RATIO: 0.5,

  /** Vesting period in days (4 weeks) */
  VESTING_PERIOD_DAYS: 28,

  /** LP maturity period in days */
  LP_MATURITY_DAYS: 7,

  /** Epoch duration in days */
  EPOCH_DURATION_DAYS: 7,

  /** Balance snapshot interval in days */
  SNAPSHOT_INTERVAL_DAYS: 1,

  /** Maximum alignment multiplier */
  MAX_ALIGNMENT_MULTIPLIER: 1.2,
} as const;

export const DEFAULT_ACTIVITY_WEIGHTS: Record<RewardActivityType, number> = {
  [RewardActivityType.ASSET_CONTRIBUTION]: 10,
  [RewardActivityType.TOKEN_ACQUIRE]: 5,
  [RewardActivityType.EXPANSION_ASSET_CONTRIBUTION]: 10,
  [RewardActivityType.EXPANSION_TOKEN_PURCHASE]: 5,
  [RewardActivityType.LP_POSITION_UPDATE]: 15,
  [RewardActivityType.WIDGET_SWAP]: 2,
  [RewardActivityType.GOVERNANCE_PROPOSAL]: 50,
  [RewardActivityType.GOVERNANCE_VOTE]: 3,
};

export interface ScoreBreakdown {
  asset_contribution?: number;
  token_acquire?: number;
  expansion_asset_contribution?: number;
  expansion_token_purchase?: number;
  lp_position_update?: number;
  widget_swap?: number;
  governance_proposal?: number;
  governance_vote?: number;
}

export interface WidgetSwapItemData {
  amount_in: string;
  expected_output: number;
  dex: string;
  tx_hash: string;
  status: string;
  token_id_in: string;
  token_id_out: string;
  submission_time: string;
  user_address: string;
  type: string;
  is_dexhunter: boolean;
}

export interface WidgetSwapEventData {
  data?: WidgetSwapItemData[];

  // Backward compatibility for flat payloads
  amount_in?: string;
  expected_output?: number;
  dex?: string;
  tx_hash?: string;
  status?: string;
  token_id_in?: string;
  token_id_out?: string;
  submission_time?: string;
  user_address?: string;
  type?: string;
  is_dexhunter?: boolean;
}
