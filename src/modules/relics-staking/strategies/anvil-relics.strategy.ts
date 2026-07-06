import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '@/database/asset.entity';
import { AnvilApiClient } from '../clients/anvil-api.client';
import {
  IStakingPlatformStrategy,
  StakeTxResult,
  UnstakeTxResult,
  StakedAssetInfo,
} from './staking-platform.interface';

/**
 * Anvil Relics Staking Platform Strategy
 * Implements staking logic for Relics NFTs on Anvil platform
 */
@Injectable()
export class AnvilRelicsStakingStrategy implements IStakingPlatformStrategy {
  private readonly logger = new Logger(AnvilRelicsStakingStrategy.name);

  readonly platform = 'anvil-relics';

  // Relics of Magma NFT policies (from TapTools service)
  readonly eligiblePolicies = [
    '94ec588251e710b7660dfd7765f08c87742a3012cce802897a3ebd28', // Vita
    '14296258677a869366d6bb01568f31f7b2e690208739b7bcdca444b2', // Porta
  ];

  // VLRM reward token (4 decimals)
  readonly rewardToken = {
    unit: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c056616c6f72756d',
    decimals: 4,
  };

  readonly stakeCollectionId = 54;

  // Anvil API batch limit
  private readonly MAX_NFTS_PER_BATCH = 50;

  constructor(
    private readonly anvilApiClient: AnvilApiClient,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
  ) {}

  /**
   * Build stake transactions with batching (up to 50 NFTs per tx)
   */
  async buildStakeTransaction(assets: Asset[], treasuryWallet: any): Promise<StakeTxResult[]> {
    this.logger.log(`Building stake transactions for ${assets.length} assets`);

    // Validate assets are eligible
    const invalidAssets = assets.filter(
      asset => !this.eligiblePolicies.includes(asset.policy_id),
    );
    if (invalidAssets.length > 0) {
      throw new Error(
        `Invalid assets for Anvil staking: ${invalidAssets.map(a => a.id).join(', ')}`,
      );
    }

    // Chunk assets into batches of 50
    const batches: Asset[][] = [];
    for (let i = 0; i < assets.length; i += this.MAX_NFTS_PER_BATCH) {
      batches.push(assets.slice(i, i + this.MAX_NFTS_PER_BATCH));
    }

    this.logger.log(`Split ${assets.length} assets into ${batches.length} batches`);

    // Build transaction for each batch
    const results: StakeTxResult[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      this.logger.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} NFTs)`);

      try {
        // Convert assets to Cardano asset units (policy.assetName)
        const assetUnits = batch.map(asset => `${asset.policy_id}.${asset.asset_id}`);

        // Call Anvil API to build unsigned transaction
        const response = await this.anvilApiClient.stakeAssetsV2(
          treasuryWallet.treasury_address,
          assetUnits,
          this.stakeCollectionId,
        );

        results.push({
          batchIndex,
          assetIds: batch.map(a => a.id),
          stakeIds: response.stakeIds,
          unsignedCbor: response.unsignedTx,
        });

        this.logger.log(`Batch ${batchIndex + 1} built successfully with ${response.stakeIds.length} stake IDs`);
      } catch (error) {
        this.logger.error(`Failed to build batch ${batchIndex + 1}: ${error.message}`, error.stack);
        throw error;
      }
    }

    return results;
  }

  /**
   * Build unstake transactions
   */
  async buildUnstakeTransaction(stakeIds: string[], treasuryWallet: any): Promise<UnstakeTxResult[]> {
    this.logger.log(`Building unstake transactions for ${stakeIds.length} stake IDs`);

    const results: UnstakeTxResult[] = [];

    // Process each stake ID individually
    for (const stakeId of stakeIds) {
      try {
        const response = await this.anvilApiClient.harvestStakeV2(
          treasuryWallet.treasury_address,
          [stakeId],
          false, // evaluateOnly = false (actual harvest)
        );

        results.push({
          stakeId,
          unsignedCbor: response.unsignedTx,
          vlrmRewards: response.rewards,
        });

        this.logger.log(`Unstake tx built for stake ID ${stakeId}, rewards: ${response.rewards}`);
      } catch (error) {
        this.logger.error(`Failed to build unstake tx for stake ID ${stakeId}: ${error.message}`, error.stack);
        throw error;
      }
    }

    return results;
  }

  /**
   * Get staked assets for a vault with reward estimates
   */
  async getStakedAssets(vaultId: string): Promise<StakedAssetInfo[]> {
    this.logger.log(`Fetching staked assets for vault ${vaultId}`);

    // Query assets with STAKED status for this platform
    const assets = await this.assetRepository.find({
      where: {
        vault_id: vaultId,
        status: 'staked' as any,
        staking_platform: this.platform,
      },
    });

    // Fetch reward estimates from Anvil API
    const results: StakedAssetInfo[] = [];
    for (const asset of assets) {
      if (!asset.stake_id) {
        this.logger.warn(`Asset ${asset.id} has STAKED status but no stake_id`);
        continue;
      }

      try {
        // Evaluate rewards for this stake
        const evaluation = await this.anvilApiClient.evaluateStakeV2(asset.stake_id);

        results.push({
          assetId: asset.id,
          stakeId: asset.stake_id,
          platform: this.platform,
          stakedAt: asset.staked_at!,
          estimatedRewards: evaluation.rewards,
        });
      } catch (error) {
        this.logger.error(`Failed to evaluate rewards for stake ID ${asset.stake_id}: ${error.message}`);
        // Include asset without rewards estimate
        results.push({
          assetId: asset.id,
          stakeId: asset.stake_id,
          platform: this.platform,
          stakedAt: asset.staked_at!,
        });
      }
    }

    return results;
  }
}
