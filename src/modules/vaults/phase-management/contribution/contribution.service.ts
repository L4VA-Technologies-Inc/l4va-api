import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ContributeReq } from './dto/contribute.req';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Proposal } from '@/database/proposal.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { AssetStatus, AssetOriginType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

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
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
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
      const assetCountResults = await this.assetRepository
        .createQueryBuilder('asset')
        .select('COUNT(DISTINCT asset.id)', 'totalCount')
        .addSelect('asset.policy_id', 'policyId')
        .addSelect('COALESCE(SUM(asset.quantity), 0)', 'totalQuantity')
        .where('asset.vault_id = :vaultId', { vaultId })
        .andWhere('asset.status IN (:...statuses)', {
          statuses: [AssetStatus.LOCKED, AssetStatus.PENDING],
        })
        .andWhere('asset.origin_type = :originType', {
          originType: AssetOriginType.CONTRIBUTED,
        })
        .groupBy('asset.policy_id')
        .getRawMany();

      currentAssetCount = assetCountResults.reduce((total, row) => {
        return total + Number(row.totalQuantity || 0);
      }, 0);

      const filteredPolicyResults = assetCountResults.filter(row => requestedPolicyIds.includes(row.policyId));

      policyCountMap = new Map(filteredPolicyResults.map(row => [row.policyId, Number(row.totalQuantity || 0)]));
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
      // return this.handleExpansionContribution(vaultId, contributeReq, userId, vaultData);
    }

    // Normal contribution flow
    if (currentAssetCount + contributeReq.assets.length > vaultData.max_contribute_assets) {
      throw new BadRequestException(
        `Adding ${contributeReq.assets.length} assets would exceed the vault's maximum capacity of ${vaultData.max_contribute_assets}. ` +
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
        const policyAssetsQuantity = assetsByPolicy[policyId].reduce(
          (total, asset) => total + (Number(asset.quantity) || 1),
          0
        );

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
   */
  // private async handleExpansionContribution(
  //   vaultId: string,
  //   contributeReq: any,
  //   userId: string,
  //   vaultData: Vault
  // ): Promise<{
  //   success: boolean;
  //   message: string;
  //   vaultId: string;
  //   txId: string;
  //   claimId?: string;
  //   vtAmount?: string;
  // }> {
  //   this.logger.log(`Processing expansion contribution for vault ${vaultId}`);

  //   // Find the active expansion proposal
  //   const expansionProposal = await this.proposalRepository.findOne({
  //     where: {
  //       vaultId,
  //       proposalType: ProposalType.EXPANSION,
  //       status: ProposalStatus.EXECUTED,
  //     },
  //     order: { executionDate: 'DESC' },
  //   });

  //   if (!expansionProposal || !expansionProposal.metadata?.expansion) {
  //     throw new BadRequestException('No active expansion configuration found');
  //   }

  //   const expansionConfig = expansionProposal.metadata.expansion;

  //   // Validate contributed assets are from whitelisted policies
  //   const contributedPolicyIds = [...new Set(contributeReq.assets.map(a => a.policyId))];
  //   const invalidPolicies = contributedPolicyIds.filter(
  //     policyId => !expansionConfig.policyIds.includes(policyId as any)
  //   );

  //   if (invalidPolicies.length > 0) {
  //     throw new BadRequestException(
  //       `Assets from policies [${invalidPolicies.join(', ')}] are not whitelisted for this expansion. ` +
  //         `Allowed policies: [${expansionConfig.policyIds.join(', ')}]`
  //     );
  //   }

  //   // Calculate total asset count (NFTs = 1 each, FTs = quantity)
  //   const assetCount = contributeReq.assets.reduce((total, asset) => {
  //     return total + (Number(asset.quantity) || 1);
  //   }, 0);

  //   // Check asset max if configured
  //   const currentCount = expansionConfig.currentAssetCount || 0;
  //   const newCount = currentCount + assetCount;

  //   if (!expansionConfig.noMax && expansionConfig.assetMax) {
  //     if (newCount > expansionConfig.assetMax) {
  //       throw new BadRequestException(
  //         `Adding ${assetCount} asset(s) would exceed expansion maximum of ${expansionConfig.assetMax}. ` +
  //           `Current: ${currentCount}, Available: ${expansionConfig.assetMax - currentCount}`
  //       );
  //     }
  //   }

  //   // Calculate VT amount based on pricing type
  //   const vtAmount = await this.calculateExpansionVTAmount(contributeReq.assets, expansionConfig, vaultData);

  //   if (vtAmount === '0') {
  //     throw new BadRequestException('Calculated VT amount is 0. Cannot process contribution.');
  //   }

  //   // Create transaction
  //   const transaction = await this.transactionsService.createTransaction({
  //     vault_id: vaultId,
  //     type: TransactionType.contribute,
  //     assets: [],
  //     userId,
  //     fee: this.systemSettingsService.protocolContributorsFee,
  //     metadata: contributeReq.assets,
  //   });

  //   // Create expansion claim for VT airdrop
  //   const claim = this.claimRepository.create({
  //     user: { id: userId },
  //     vault: { id: vaultData.id },
  //     transaction: { id: transaction.id },
  //     type: ClaimType.EXPANSION,
  //     status: ClaimStatus.AVAILABLE,
  //     amount: vtAmount,
  //     description: `Expansion contribution: ${assetCount} asset(s) → ${vtAmount} VT`,
  //     metadata: {
  //       expansionProposalId: expansionProposal.id,
  //       pricingMethod: expansionConfig.priceType,
  //       limitPrice: expansionConfig.limitPrice,
  //       assetCount,
  //       calculatedAt: new Date().toISOString(),
  //       assets: contributeReq.assets.map(a => ({
  //         policyId: a.policyId,
  //         assetId: a.assetId,
  //         quantity: a.quantity || 1,
  //       })),
  //     },
  //   });

  //   await this.claimRepository.save(claim);

  //   // Update expansion proposal metadata with new count
  //   await this.proposalRepository.update(
  //     { id: expansionProposal.id },
  //     {
  //       metadata: {
  //         ...expansionProposal.metadata,
  //         expansion: {
  //           ...expansionConfig,
  //           currentAssetCount: newCount,
  //         },
  //       },
  //     }
  //   );

  //   this.logger.log(
  //     `Expansion contribution processed: ${assetCount} assets → ${vtAmount} VT. ` +
  //       `Asset count: ${currentCount} → ${newCount}${expansionConfig.assetMax ? `/${expansionConfig.assetMax}` : ''}`
  //   );

  //   // Check if max is reached and trigger closure
  //   if (!expansionConfig.noMax && expansionConfig.assetMax && newCount >= expansionConfig.assetMax) {
  //     this.logger.log(`Asset max reached (${newCount}/${expansionConfig.assetMax}). Expansion will be closed.`);
  //     // Note: The actual closure will be handled by the governance execution service via event
  //     // or you can emit an event here to trigger it
  //   }

  //   return {
  //     success: true,
  //     message: `Expansion contribution accepted. You will receive ${vtAmount} VT tokens.`,
  //     vaultId,
  //     txId: transaction.id,
  //     claimId: claim.id,
  //     vtAmount,
  //   };
  // }

  /**
   * Calculate VT amount for expansion contribution
   */
  private async calculateExpansionVTAmount(
    assets: Array<{ policyId: string; assetId: string; quantity?: number }>,
    expansionConfig: any,
    vault: Vault
  ): Promise<string> {
    if (expansionConfig.priceType === 'limit') {
      // Simple limit pricing: VT = asset count × limit price
      const totalAssets = assets.reduce((sum, asset) => sum + (Number(asset.quantity) || 1), 0);
      const vtAmount = totalAssets * expansionConfig.limitPrice;

      // Convert to integer (6 decimals precision)
      const vtAmountLovelace = BigInt(Math.round(vtAmount * 1_000_000));

      return vtAmountLovelace.toString();
    } else {
      // Market pricing: VT = (asset floor price ÷ VT price) for each asset
      // TODO: Implement market pricing with DexHunter integration
      // For now, throw an error indicating it needs implementation
      throw new BadRequestException('Market pricing is not yet implemented. Please use limit pricing for expansion.');

      // Future implementation:
      // let totalVT = BigInt(0);
      //
      // for (const asset of assets) {
      //   const quantity = Number(asset.quantity) || 1;
      //
      //   // Get asset floor price from DexHunter or Oracle
      //   const floorPriceAda = await this.getAssetFloorPrice(asset.policyId, asset.asset_id);
      //
      //   // Get VT price from LP pool or pricing service
      //   const vtPriceAda = await this.getVaultTokenPrice(vault.id);
      //
      //   if (vtPriceAda === 0) {
      //     throw new BadRequestException('VT price unavailable or zero');
      //   }
      //
      //   // Calculate VT for this asset
      //   const assetVT = (floorPriceAda / vtPriceAda) * quantity;
      //   const assetVTLovelace = BigInt(Math.round(assetVT * 1_000_000));
      //
      //   totalVT += assetVTLovelace;
      // }
      //
      // return totalVT.toString();
    }
  }

  /**
   * Get floor price for an asset (placeholder for future implementation)
   */
  private async getAssetFloorPrice(policyId: string, assetId: string): Promise<number> {
    // TODO: Integrate with DexHunter pricing service
    // return await this.dexHunterPricingService.getFloorPrice(policyId + assetId);
    throw new Error('Asset floor price fetching not implemented');
  }

  /**
   * Get current VT price for a vault (placeholder for future implementation)
   */
  private async getVaultTokenPrice(vaultId: string): Promise<number> {
    // TODO: Integrate with LP pool or pricing service
    // return await this.lpPricingService.getVTPrice(vaultId);
    throw new Error('VT price fetching not implemented');
  }
}
