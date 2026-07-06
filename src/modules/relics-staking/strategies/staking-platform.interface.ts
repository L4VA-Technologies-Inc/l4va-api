import { Asset } from '@/database/asset.entity';

/**
 * Result of building a stake transaction
 */
export interface StakeTxResult {
  batchIndex: number;
  assetIds: string[];
  stakeIds: string[];
  txHash?: string;
  unsignedCbor: string;
}

/**
 * Result of building an unstake transaction
 */
export interface UnstakeTxResult {
  stakeId: string;
  txHash?: string;
  unsignedCbor: string;
  vlrmRewards?: string;
}

/**
 * Staked asset information with rewards
 */
export interface StakedAssetInfo {
  assetId: string;
  stakeId: string;
  platform: string;
  stakedAt: Date;
  estimatedRewards?: string;
}

/**
 * Platform-specific staking strategy interface
 * Each external staking platform implements this interface
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
   * Build stake transactions for multiple assets (batched)
   * @param assets Assets to stake (max 50 per batch)
   * @param treasuryWallet Treasury wallet for signing
   * @returns Array of stake transaction results (one per batch)
   */
  buildStakeTransaction(assets: Asset[], treasuryWallet: any): Promise<StakeTxResult[]>;

  /**
   * Build unstake transaction for stake IDs
   * @param stakeIds Stake IDs to unstake
   * @param treasuryWallet Treasury wallet for signing
   * @returns Unstake transaction result
   */
  buildUnstakeTransaction(stakeIds: string[], treasuryWallet: any): Promise<UnstakeTxResult[]>;

  /**
   * Get staked assets for a vault
   * @param vaultId Vault ID
   * @returns Staked asset information
   */
  getStakedAssets(vaultId: string): Promise<StakedAssetInfo[]>;
}
