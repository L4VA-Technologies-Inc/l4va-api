import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ContributeReq } from './dto/contribute.req';

import { Asset } from '@/database/asset.entity';
import { Proposal } from '@/database/proposal.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { AssetStatus, AssetOriginType, AssetType } from '@/types/asset.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

// Maximum safe quantity for JavaScript number handling
// Using Number.MAX_SAFE_INTEGER (2^53 - 1) to prevent precision loss
const MAX_SAFE_QUANTITY = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991
const LARGE_QUANTITY_WARNING_THRESHOLD = 1000000000; // 1 billion

@Injectable()
export class ContributionService {
  private readonly logger = new Logger(ContributionService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Proposal)
    private readonly proposalRepository: Repository<Proposal>,
    private readonly transactionsService: TransactionsService,
    private readonly systemSettingsService: SystemSettingsService
  ) {}

  async contribute(
    vaultId: string,
    contributeReq: ContributeReq,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
  }> {
    const assetsByPolicy = contributeReq.assets.reduce(
      (acc, asset) => {
        if (!acc[asset.policyId]) {
          acc[asset.policyId] = [];
        }
        acc[asset.policyId].push(asset);
        return acc;
      },
      {} as Record<string, any[]>
    );

    const requestedPolicyIds = Object.keys(assetsByPolicy);

    const vaultQuery = this.vaultRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.owner', 'owner')
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .where('vault.id = :vaultId', { vaultId })
      .select([
        'vault.id',
        'vault.vault_status',
        'vault.max_contribute_assets',
        'owner.id',
        'assets_whitelist.id',
        'assets_whitelist.policy_id',
        'assets_whitelist.asset_count_cap_max',
      ]);

    const vaultData = await vaultQuery.getOne();

    if (!vaultData) {
      throw new NotFoundException('Vault not found');
    }

    let currentAssetCount = 0;
    let policyCountMap = new Map<string, number>();

    if (requestedPolicyIds.length > 0) {
      // Fetch individual assets to properly convert raw quantities to decimal for FTs
      const existingAssets = await this.assetRepository
        .createQueryBuilder('asset')
        .select('asset.policy_id', 'policyId')
        .addSelect('asset.type', 'assetType')
        .addSelect('asset.quantity', 'rawQuantity')
        .addSelect('asset.decimals', 'decimals')
        .where('asset.vault_id = :vaultId', { vaultId })
        .andWhere('asset.status IN (:...statuses)', {
          statuses: [AssetStatus.PENDING, AssetStatus.LOCKED, AssetStatus.EXTRACTED],
        })
        .andWhere('asset.origin_type = :originType', {
          originType: AssetOriginType.CONTRIBUTED,
        })
        .getRawMany();

      // Calculate decimal-adjusted counts per policy
      const policyCountsMap = new Map<string, number>();
      existingAssets.forEach(asset => {
        const rawQuantity = Number(asset.rawQuantity) || 0;
        let decimalQuantity: number;

        if (asset.assetType === AssetType.NFT) {
          decimalQuantity = 1;
        } else {
          // FT: convert raw to decimal
          const decimals = Number(asset.decimals) || 6;
          decimalQuantity = decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
        }

        const currentCount = policyCountsMap.get(asset.policyId) || 0;
        policyCountsMap.set(asset.policyId, currentCount + decimalQuantity);
      });

      // Calculate total asset count across all policies
      currentAssetCount = Array.from(policyCountsMap.values()).reduce((sum, count) => sum + count, 0);

      // Filter to only requested policies
      policyCountMap = new Map(requestedPolicyIds.map(policyId => [policyId, policyCountsMap.get(policyId) || 0]));
    }

    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'address'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if vault is in contribution OR expansion phase
    if (vaultData.vault_status !== VaultStatus.contribution && vaultData.vault_status !== VaultStatus.expansion) {
      throw new BadRequestException('Vault is not accepting contributions');
    }

    // Handle expansion mode contributions
    if (vaultData.vault_status === VaultStatus.expansion) {
      return this.handleExpansionContribution(vaultId, contributeReq, userId);
    }

    // Calculate decimal-adjusted quantity for new contribution (to match currentAssetCount units)
    const contributionAssetCount = contributeReq.assets.reduce((total, asset) => {
      const rawQuantity = Number(asset.quantity) || 1;
      if (asset.type === AssetType.FT) {
        const decimals = asset.decimals ?? asset.metadata?.decimals ?? 6;
        const decimalQuantity = decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
        return total + decimalQuantity;
      }
      // NFTs always count as 1
      return total + 1;
    }, 0);

    // Normal contribution flow - compare decimal-adjusted quantities
    if (currentAssetCount + contributionAssetCount > vaultData.max_contribute_assets) {
      throw new BadRequestException(
        `Adding ${contributionAssetCount} assets would exceed the vault's maximum capacity of ${vaultData.max_contribute_assets}. ` +
          `The vault currently has ${currentAssetCount} assets.`
      );
    }

    // Check contributor whitelist
    if (vaultData.owner.id !== userId) {
      const vaultWithWhitelist = await this.vaultRepository
        .createQueryBuilder('vault')
        .leftJoinAndSelect('vault.contributor_whitelist', 'whitelist')
        .where('vault.id = :vaultId', { vaultId })
        .getOne();

      if (vaultWithWhitelist?.contributor_whitelist?.length > 0) {
        const isWhitelisted = vaultWithWhitelist.contributor_whitelist.some(
          entry => entry.wallet_address === user.address
        );
        if (!isWhitelisted) {
          throw new BadRequestException('User is not in contributor whitelist');
        }
      }
    }

    if (contributeReq.assets.length > 0) {
      const invalidAssets: string[] = [];
      const policyExceedsLimit: Array<{
        policyId: string;
        existing: number;
        adding: number;
        max: number;
      }> = [];

      for (const policyId of requestedPolicyIds) {
        const whitelistedAsset = vaultData.assets_whitelist?.find(wa => wa.policy_id === policyId);

        if (!whitelistedAsset) {
          invalidAssets.push(policyId);
          continue;
        }

        const existingPolicyCount = policyCountMap.get(policyId) || 0;
        // Calculate decimal-adjusted quantity for this contribution
        const policyAssetsQuantity = assetsByPolicy[policyId].reduce((total, asset) => {
          const rawQuantity = Number(asset.quantity) || 1;
          if (asset.type === AssetType.NFT) {
            return total + 1;
          }
          // FT: convert raw to decimal
          const decimals = asset.decimals ?? asset.metadata?.decimals ?? 6;
          const decimalQuantity = decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
          return total + decimalQuantity;
        }, 0);

        // Additional safety check: prevent individual FT quantities from exceeding reasonable limits
        for (const asset of assetsByPolicy[policyId]) {
          const qty = Number(asset.quantity) || 0;
          if (asset.type === 'ft' && qty > MAX_SAFE_QUANTITY) {
            throw new BadRequestException(`Asset quantity ${qty} exceeds maximum safe value for policy ${policyId}`);
          }

          // Log warning for very large quantities
          if (qty > LARGE_QUANTITY_WARNING_THRESHOLD) {
            this.logger.warn(
              `Large quantity contribution detected: ${qty} tokens for policy ${policyId} by user ${userId}`
            );
          }
        }

        if (
          whitelistedAsset.asset_count_cap_max !== null &&
          whitelistedAsset.asset_count_cap_max > 0 &&
          existingPolicyCount + policyAssetsQuantity > whitelistedAsset.asset_count_cap_max
        ) {
          policyExceedsLimit.push({
            policyId,
            existing: existingPolicyCount,
            adding: policyAssetsQuantity,
            max: whitelistedAsset.asset_count_cap_max,
          });
        }
      }

      if (invalidAssets.length > 0) {
        throw new BadRequestException(`Some assets are not in the vault's whitelist: ${invalidAssets.join(', ')}`);
      }

      if (policyExceedsLimit.length > 0) {
        const errorMessages = policyExceedsLimit.map(
          policy =>
            `Policy ${policy.policyId}: has ${policy.existing}, adding ${policy.adding} would exceed max ${policy.max}`
        );
        throw new BadRequestException(`Policy limits exceeded: ${errorMessages.join('; ')}`);
      }
    }

    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.contribute,
      assets: [],
      userId,
      fee: this.systemSettingsService.protocolContributorsFee,
      metadata: contributeReq.assets,
    });

    return {
      success: true,
      message: 'Contribution request accepted, transaction created',
      vaultId,
      txId: transaction.id,
    };
  }

  /**
   * Handle contribution when vault is in expansion mode
   * Creates transaction only - claims will be created during expansion->locked transition
   */
  private async handleExpansionContribution(
    vaultId: string,
    contributeReq: any,
    userId: string
  ): Promise<{
    success: boolean;
    message: string;
    vaultId: string;
    txId: string;
  }> {
    this.logger.log(`Processing expansion contribution for vault ${vaultId}`);

    // Find the active expansion proposal
    const expansionProposal = await this.proposalRepository.findOne({
      where: {
        vaultId,
        proposalType: ProposalType.EXPANSION,
        status: ProposalStatus.EXECUTED,
      },
      order: { executionDate: 'DESC' },
    });

    if (!expansionProposal || !expansionProposal.metadata?.expansion) {
      throw new BadRequestException('No active expansion configuration found');
    }

    const expansionConfig = expansionProposal.metadata.expansion;

    // Validate contributed assets are from whitelisted policies
    const contributedPolicyIds = [...new Set(contributeReq.assets.map(a => a.policyId))];
    const invalidPolicies = contributedPolicyIds.filter(
      policyId => !expansionConfig.policyIds.includes(policyId as any)
    );

    if (invalidPolicies.length > 0) {
      throw new BadRequestException(
        `Assets from policies [${invalidPolicies.join(', ')}] are not whitelisted for this expansion. ` +
          `Allowed policies: [${expansionConfig.policyIds.join(', ')}]`
      );
    }

    // Calculate total asset count for this contribution
    // FTs: convert raw quantity to decimal (e.g., 3,500,000 with 6 decimals = 3.5 tokens)
    // NFTs: always count as 1
    const contributionAssetCount = contributeReq.assets.reduce((total, asset) => {
      const rawQuantity = Number(asset.quantity) || 1;
      if (asset.type === AssetType.FT) {
        const decimals = asset.decimals ?? asset.metadata?.decimals ?? 6;
        const decimalQuantity = decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
        return total + decimalQuantity;
      }
      // NFTs always count as 1
      return total + 1;
    }, 0);

    // Check asset max if configured - count already CONFIRMED contributions
    if (!expansionConfig.noMax && expansionConfig.assetMax) {
      // Count currently locked expansion assets
      // For NFTs: count each as 1
      // For FTs: sum decimal-adjusted quantities (raw quantity / 10^decimals)
      const expansionAssets = await this.assetRepository
        .createQueryBuilder('asset')
        .select('asset.type', 'assetType')
        .addSelect('asset.quantity', 'rawQuantity')
        .addSelect('asset.decimals', 'decimals')
        .innerJoin('asset.transaction', 'tx')
        .where('asset.vault_id = :vaultId', { vaultId })
        .andWhere('asset.status IN (:...statuses)', {
          statuses: [AssetStatus.PENDING, AssetStatus.LOCKED, AssetStatus.EXTRACTED],
        })
        .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
        .andWhere('tx.created_at >= (SELECT expansion_phase_start FROM vaults WHERE id = :vaultId)', { vaultId })
        .getRawMany();

      const currentAssetCount = expansionAssets.reduce((total, asset) => {
        if (asset.assetType === AssetType.NFT) {
          return total + 1;
        }
        // FT: convert raw to decimal
        const rawQuantity = Number(asset.rawQuantity) || 0;
        const decimals = Number(asset.decimals) || 6;
        const decimalQuantity = decimals > 0 ? rawQuantity / Math.pow(10, decimals) : rawQuantity;
        return total + decimalQuantity;
      }, 0);

      const projectedCount = currentAssetCount + contributionAssetCount;

      if (projectedCount > expansionConfig.assetMax) {
        const availableSlots = Math.max(0, expansionConfig.assetMax - currentAssetCount);
        throw new BadRequestException(
          `This vault can only accept ${availableSlots} more asset${availableSlots !== 1 ? 's' : ''} during expansion. ` +
            `You're trying to contribute ${contributionAssetCount}, but the vault already has ${currentAssetCount} of ${expansionConfig.assetMax} total allowed.`
        );
      }

      this.logger.log(
        `Expansion asset check: ${currentAssetCount} (confirmed + pending) + ${contributionAssetCount} new = ${projectedCount}/${expansionConfig.assetMax}`
      );
    }

    // Create transaction (claims will be created during expansion->locked transition)
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.contribute,
      assets: [],
      userId,
      fee: this.systemSettingsService.protocolContributorsFee,
      metadata: contributeReq.assets,
    });

    return {
      success: true,
      message:
        'Expansion contribution request accepted. VT tokens will be calculated and distributed when the expansion phase completes.',
      vaultId,
      txId: transaction.id,
    };
  }
}
