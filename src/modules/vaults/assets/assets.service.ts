import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain } from 'class-transformer';
import { Repository, In } from 'typeorm';

import { CreateAssetDto } from './dto/create-asset.dto';
import { GetAcquiredAssetsRes } from './dto/get-acquired-assets.res';
import { GetContributedAssetsRes } from './dto/get-contributed-assets.res';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private readonly claimsRepository: Repository<Claim>,
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>
  ) {}

  async addAssetToVault(userId: string, data: CreateAssetDto): Promise<Record<string, unknown>> {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: data.vaultId,
        owner: { id: userId },
      },
    });

    const user = await this.userRepository.findOne({
      where: {
        id: userId,
      },
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }

    if (!user) {
      throw new BadRequestException('User not found or access denied');
    }

    if (vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Assets can only be added during the contribution phase');
    }

    // Validate asset type-specific requirements
    if (data.type === AssetType.NFT && !data.tokenId) {
      throw new BadRequestException('Token ID is required for NFT assets');
    }

    if (data.type === AssetType.FT && !data.dexPrice) {
      throw new BadRequestException('DEX price is required for FT assets');
    }

    // Create and save the asset
    const asset = this.assetsRepository.create({
      type: data.type,
      quantity: data.quantity,
      floor_price: data.floorPrice,
      dex_price: data.dexPrice,
      last_valuation: new Date(),
      status: AssetStatus.PENDING,
      metadata: data.metadata,
      added_by: user,
    });

    await this.assetsRepository.save(asset);
    return instanceToPlain(asset);
  }

  async getVaultAssets(
    vaultId: string,
    page: number = 1,
    limit: number = 10,
    search: string = ''
  ): Promise<GetContributedAssetsRes> {
    let queryBuilder = this.assetsRepository
      .createQueryBuilder('asset')
      .select([
        'asset.id',
        'asset.policy_id',
        'asset.asset_id',
        'asset.type',
        'asset.quantity',
        'asset.floor_price',
        'asset.dex_price',
        'asset.deleted',
        'asset.last_valuation',
        'asset.status',
        'asset.locked_at',
        'asset.released_at',
        'asset.origin_type',
        'asset.image',
        'asset.decimals',
        'asset.name',
        'asset.description',
        'asset.added_at',
        'asset.updated_at',
      ])
      .where('asset.vault_id = :vaultId', { vaultId })
      .andWhere('asset.origin_type IN (:...originTypes)', {
        originTypes: [AssetOriginType.CONTRIBUTED, AssetOriginType.FEE],
      })
      .andWhere('asset.status IN (:...statuses)', {
        statuses: [AssetStatus.LOCKED, AssetStatus.RELEASED],
      });

    if (search) {
      queryBuilder = queryBuilder.andWhere('asset.metadata::text ILIKE :search', { search: `%${search}%` });
    }

    const [assets, total] = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('asset.added_at', 'DESC')
      .getManyAndCount();

    return {
      items: assets.map(asset => instanceToPlain(asset)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
  async getAcquiredAssets(vaultId: string, page: number = 1, limit: number = 10): Promise<GetAcquiredAssetsRes> {
    // Verify vault ownership
    const vault = await this.vaultsRepository.exists({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }

    const [assets, total] = await this.assetsRepository.findAndCount({
      where: {
        vault: {
          id: vaultId,
        },
        origin_type: AssetOriginType.ACQUIRED,
        status: In([AssetStatus.LOCKED, AssetStatus.RELEASED, AssetStatus.DISTRIBUTED, AssetStatus.LISTED]),
      },
      select: {
        id: true,
        policy_id: true,
        asset_id: true,
        type: true,
        quantity: true,
        floor_price: true,
        dex_price: true,
        deleted: true,
        last_valuation: true,
        status: true,
        locked_at: true,
        released_at: true,
        origin_type: true,
        image: true,
        decimals: true,
        name: true,
        description: true,
        added_at: true,
        updated_at: true,
      },
      skip: (page - 1) * limit,
      take: limit,
      order: {
        added_at: 'DESC',
      },
    });

    return {
      items: assets.map(asset => instanceToPlain(asset)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async releaseAssetsByClaim(claimIds: string[]): Promise<number> {
    if (claimIds.length === 0) {
      throw new BadRequestException('At least one claim ID must be provided');
    }

    const claimsWithAssets = await this.claimsRepository
      .createQueryBuilder('claim')
      .select([
        'claim.id',
        'claim.status',
        'transaction.id',
        'asset.id',
        'asset.status',
        'asset.type',
        'asset.quantity',
        'asset.policy_id',
        'asset.asset_id',
        'asset.metadata',
        'asset.added_at',
        'asset.locked_at',
        'vault.id',
        'vault.vault_status',
      ])
      .innerJoin('claim.transaction', 'transaction')
      .innerJoin('transaction.assets', 'asset')
      .innerJoin('asset.vault', 'vault')
      .where('claim.id IN (:...claimIds)', { claimIds })
      .andWhere('asset.deleted = false')
      .getMany();

    if (claimsWithAssets.length === 0) {
      throw new BadRequestException('No claims found or no associated assets');
    }

    if (claimsWithAssets.length !== claimIds.length) {
      const foundIds = claimsWithAssets.map(c => c.id);
      const missingIds = claimIds.filter(id => !foundIds.includes(id));
      throw new BadRequestException(`Claims not found: ${missingIds.join(', ')}`);
    }

    const assetsToRelease: string[] = [];
    for (const claim of claimsWithAssets) {
      // Process ALL assets associated with the transaction, not just the first one
      for (const asset of claim.transaction.assets) {
        if (!asset) {
          continue;
        }

        if (asset.status !== AssetStatus.LOCKED) {
          this.logger.warn(
            `Asset ${asset.id} for claim ${claim.id} cannot be released. Current status: ${asset.status}. Skipping.`
          );
          continue;
        }

        assetsToRelease.push(asset.id);
      }
    }

    if (assetsToRelease.length === 0) {
      this.logger.warn(`No locked assets found for ${claimIds.length} claims to release`);
      return 0;
    }

    const now = new Date();
    await this.assetsRepository.update(
      { id: In(assetsToRelease) },
      {
        status: AssetStatus.RELEASED,
        released_at: now,
        updated_at: now,
      }
    );

    this.logger.log(`Released ${assetsToRelease.length} assets for ${claimIds.length} cancellation claims`);
    return assetsToRelease.length;
  }

  async markAssetsAsDistributedByTransactions(transactionIds: string[]): Promise<void> {
    if (transactionIds.length === 0) {
      return;
    }

    const assets = await this.assetsRepository.find({
      where: {
        transaction: { id: In(transactionIds) },
        deleted: false,
        status: AssetStatus.LOCKED, // Only locked assets can be distributed
      },
    });

    if (assets.length === 0) {
      throw new BadRequestException(`No locked assets found for ${transactionIds.length} transactions`);
    }

    await this.assetsRepository.update(
      {
        transaction: { id: In(transactionIds) },
        status: AssetStatus.LOCKED,
        deleted: false,
      },
      {
        status: AssetStatus.DISTRIBUTED,
      }
    );
  }

  async markAssetsAsListed(
    assetIds: string[],
    listingInfo?: {
      market?: string;
      price?: number;
      txHash?: string;
    }
  ): Promise<void> {
    if (assetIds.length === 0) return;

    await this.assetsRepository.update(
      {
        id: In(assetIds),
        status: AssetStatus.EXTRACTED, // Only extracted assets can be listed
        deleted: false,
      },
      {
        status: AssetStatus.LISTED,
        listing_market: listingInfo?.market,
        listing_price: listingInfo?.price,
        listing_tx_hash: listingInfo?.txHash,
        listed_at: new Date(),
      }
    );
  }

  async markAssetsAsSold(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) return;

    await this.assetsRepository.update(
      {
        id: In(assetIds),
        status: AssetStatus.LISTED, // Only listed assets can be sold
        deleted: false,
      },
      { status: AssetStatus.SOLD }
    );
  }

  async markAssetsAsUnlisted(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) return;

    await this.assetsRepository.update(
      {
        id: In(assetIds),
        status: AssetStatus.LISTED,
        deleted: false,
      },
      {
        status: AssetStatus.EXTRACTED,
        listing_market: null,
        listing_price: null,
        listing_tx_hash: null,
        listed_at: null,
      }
    );
  }

  /**
   * Mark multiple assets as listed with individual listing prices
   */
  async markAssetsAsListedWithPrices(
    listings: Array<{
      assetId: string;
      price: number;
      market: string;
      txHash: string;
    }>
  ): Promise<void> {
    if (listings.length === 0) return;

    const listedAt = new Date();

    await Promise.all(
      listings.map(listing =>
        this.assetsRepository.update(
          {
            id: listing.assetId,
            status: AssetStatus.EXTRACTED,
            deleted: false,
          },
          {
            status: AssetStatus.LISTED,
            listing_market: listing.market,
            listing_price: listing.price,
            listing_tx_hash: listing.txHash,
            listed_at: listedAt,
          }
        )
      )
    );
  }

  /**
   * Update listing prices for assets that are already listed
   * Updates listing_price and listing_tx_hash with the new transaction
   */
  async updateListingPrices(
    updates: Array<{
      assetId: string;
      newPrice: number;
      txHash: string;
    }>
  ): Promise<void> {
    if (updates.length === 0) return;

    await Promise.all(
      updates.map(update =>
        this.assetsRepository.update(
          {
            id: update.assetId,
            status: AssetStatus.LISTED,
            deleted: false,
          },
          {
            listing_price: update.newPrice,
            listing_tx_hash: update.txHash,
          }
        )
      )
    );
  }

  /**
   * Updates asset prices and last valuation timestamp after calculation
   * Also updates vault cached totals for affected vaults
   * @param assets List of assets with updated price information
   */
  async updateBulkAssetValuations(
    assets: Array<{
      policyId: string;
      isNft: boolean;
      assetId: string;
      valueAda: number;
    }>
  ): Promise<void> {
    try {
      // Track affected vault IDs
      const affectedVaultIds = new Set<string>();

      for (const asset of assets) {
        // Update asset prices
        await this.assetsRepository.update(
          {
            policy_id: asset.policyId,
            asset_id: asset.assetId,
            deleted: false,
          },
          {
            ...(asset.isNft ? { floor_price: asset.valueAda } : { dex_price: asset.valueAda }),
            last_valuation: new Date(),
          }
        );

        // Find affected vaults
        const assetsWithVaults = await this.assetsRepository.find({
          where: {
            policy_id: asset.policyId,
            asset_id: asset.assetId,
            deleted: false,
          },
          relations: ['vault'],
          select: ['id', 'vault'],
        });

        assetsWithVaults.forEach(a => {
          if (a.vault?.id) {
            affectedVaultIds.add(a.vault.id);
          }
        });
      }

      // Note: Vault totals update will be triggered by scheduled job or manually
      // We don't await it here to avoid blocking the price update process
    } catch (error) {
      throw new Error(`Failed to update asset valuations: ${error.message}`);
    }
  }

  async softDeleteAsset(assetId: string, userId: string): Promise<void> {
    const asset = await this.assetsRepository.findOne({
      where: { id: assetId, added_by: { id: userId }, deleted: false },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    asset.deleted = true;
    asset.updated_at = new Date();

    await this.assetsRepository.save(asset);
  }
}
