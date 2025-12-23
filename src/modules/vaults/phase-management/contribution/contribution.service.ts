import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ContributeReq } from './dto/contribute.req';

import { Asset } from '@/database/asset.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { AssetStatus, AssetOriginType } from '@/types/asset.types';
import { TransactionType } from '@/types/transaction.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class ContributionService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
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

    if (vaultData.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Vault is not in contribution phase');
    }

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
}
