import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '@/database/asset.entity';
import { AnvilRelicsStakingStrategy } from './strategies/anvil-relics.strategy';
import { IStakingPlatformStrategy } from './strategies/staking-platform.interface';

/**
 * Core service for Relics NFT staking operations
 * Delegates to platform-specific strategies
 */
@Injectable()
export class RelicsStakingService {
  private readonly logger = new Logger(RelicsStakingService.name);
  private readonly strategies: Map<string, IStakingPlatformStrategy> = new Map();

  constructor(
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly anvilStrategy: AnvilRelicsStakingStrategy,
  ) {
    // Register available strategies
    this.strategies.set(this.anvilStrategy.platform, this.anvilStrategy);
  }

  /**
   * Get strategy for a specific platform
   */
  getStrategy(platform: string): IStakingPlatformStrategy {
    const strategy = this.strategies.get(platform);
    if (!strategy) {
      throw new NotFoundException(`Staking platform '${platform}' not found`);
    }
    return strategy;
  }

  /**
   * Get all available staking platforms
   */
  getAvailablePlatforms(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Get assets eligible for staking on a specific platform
   */
  async getEligibleAssets(vaultId: string, platform: string): Promise<Asset[]> {
    const strategy = this.getStrategy(platform);

    const assets = await this.assetRepository.find({
      where: {
        vault_id: vaultId,
        status: 'extracted' as any,
        staking_platform: null as any,
      },
    });

    // Filter by eligible policies
    return assets.filter(asset => strategy.eligiblePolicies.includes(asset.policy_id));
  }

  /**
   * Get staked assets for a vault (optionally filtered by platform)
   */
  async getVaultStakedAssets(vaultId: string, platform?: string) {
    if (platform) {
      const strategy = this.getStrategy(platform);
      return strategy.getStakedAssets(vaultId);
    }

    // Get all staked assets across all platforms
    const assets = await this.assetRepository.find({
      where: {
        vault_id: vaultId,
        status: 'staked' as any,
      },
    });

    // Group by platform and fetch details
    const grouped = assets.reduce((acc, asset) => {
      const platform = asset.staking_platform || 'unknown';
      if (!acc[platform]) {
        acc[platform] = [];
      }
      acc[platform].push(asset);
      return acc;
    }, {} as Record<string, Asset[]>);

    const results = [];
    for (const [platformKey, platformAssets] of Object.entries(grouped)) {
      try {
        const strategy = this.getStrategy(platformKey);
        const stakedInfo = await strategy.getStakedAssets(vaultId);
        results.push(...stakedInfo);
      } catch (error) {
        this.logger.error(`Failed to fetch staked assets for platform ${platformKey}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Get staking statistics for a vault
   */
  async getVaultStakingStats(vaultId: string) {
    const stakedAssets = await this.assetRepository.find({
      where: {
        vault_id: vaultId,
        status: 'staked' as any,
      },
    });

    // Get VLRM rewards (assets with STAKING_REWARD origin)
    const rewardAssets = await this.assetRepository.find({
      where: {
        vault_id: vaultId,
        origin_type: 'staking_reward' as any,
      },
    });

    // Group by platform
    const platformStats = stakedAssets.reduce((acc, asset) => {
      const platform = asset.staking_platform || 'unknown';
      if (!acc[platform]) {
        acc[platform] = {
          platform,
          totalStaked: 0,
          assets: [],
        };
      }
      acc[platform].totalStaked++;
      acc[platform].assets.push(asset.id);
      return acc;
    }, {} as Record<string, any>);

    // Calculate total VLRM earned (sum of STAKING_REWARD assets)
    const totalVlrmEarned = rewardAssets.reduce((sum, asset) => {
      return sum + (parseFloat(asset.quantity.toString()) || 0);
    }, 0);

    return {
      totalStaked: stakedAssets.length,
      totalVlrmEarned: totalVlrmEarned.toString(),
      platforms: Object.values(platformStats),
    };
  }

  /**
   * Sync stake status from external platform
   * Used to refresh rewards and verify stake existence
   */
  async syncStakeStatus(assetId: string): Promise<void> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId },
    });

    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    if (!asset.staking_platform || !asset.stake_id) {
      throw new Error(`Asset ${assetId} is not staked`);
    }

    const strategy = this.getStrategy(asset.staking_platform);

    // Strategy will fetch latest data from platform API
    const stakedInfo = await strategy.getStakedAssets(asset.vault_id);
    const assetInfo = stakedInfo.find(info => info.assetId === assetId);

    if (!assetInfo) {
      this.logger.warn(`Asset ${assetId} not found in platform stake list, may have been unstaked externally`);
    }

    this.logger.log(`Synced stake status for asset ${assetId}, rewards: ${assetInfo?.estimatedRewards || 'N/A'}`);
  }
}
