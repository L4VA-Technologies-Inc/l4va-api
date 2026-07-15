import { Asset } from '@/database/asset.entity';

/** Result of a completed stake execution (one Anvil batch = one stakeId) */
export interface StakeExecutionResult {
  batchIndex: number;
  stakeId: number;
  txHash: string;
  /** DB asset UUIDs included in this batch */
  assetIds: string[];
}

/** Result of a completed unstake / harvest execution */
export interface UnstakeExecutionResult {
  stakeId: number;
  txHash: string;
  /** Raw VLRM amount received (4 decimals), if claim=true and rewards detected */
  claimedVlrmRaw?: string;
}

/**
 * Staked asset information (from DB + Anvil API)
 */
export interface StakedAssetInfo {
  assetId: string;
  stakeId: string;
  platform: string;
  stakedAt: Date;
  estimatedRewards?: string;
}

/**
 * Context passed to the strategy for executing transactions.
 * Contains treasury credentials and UTxOs.
 */
export interface StakingExecutionContext {
  vaultId: string;
  /** Treasury address in bech32 format */
  treasuryAddress: string;
}

/**
 * Platform-specific staking strategy interface.
 * Each external staking platform implements this interface.
 */
export interface IStakingPlatformStrategy {
  /** Platform identifier (e.g., 'anvil-relics') */
  readonly platform: string;

  /** NFT policy IDs eligible for staking on this platform */
  readonly eligiblePolicies: string[];

  /** Reward token configuration */
  readonly rewardToken: {
    unit: string;
    decimals: number;
  };

  /** Platform-specific stake collection ID */
  readonly stakeCollectionId: number;

  /**
   * Execute staking for a list of assets, handling batching, signing, and submission.
   * @returns One result per batch (batch size determined by platform limit)
   */
  executeStake(assets: Asset[], ctx: StakingExecutionContext): Promise<StakeExecutionResult[]>;

  /**
   * Execute unstaking for a list of Anvil stake IDs, handling signing and submission.
   * @param stakeIds  Anvil numeric stake IDs to unstake
   * @param claim     true = also claim accrued VLRM rewards
   */
  executeUnstake(stakeIds: number[], ctx: StakingExecutionContext, claim: boolean): Promise<UnstakeExecutionResult[]>;

  /**
   * Fetch live staking data from the external platform for a treasury address.
   */
  getAnvilStakes(treasuryAddress: string): Promise<any[]>;
}
