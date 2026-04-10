import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Repository, In } from 'typeorm';

import { CreateAssetDto } from './dto/create-asset.dto';
import { GetAcquiredAssetsRes } from './dto/get-acquired-assets.res';
import { AssetsFilterDto } from './dto/get-contributed-assets.req';
import { AssetItemDto, GetContributedAssetsRes } from './dto/get-contributed-assets.res';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Market } from '@/database/market.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { DexHunterPricingService } from '@/modules/dexhunter/dexhunter-pricing.service';
import { SystemSettingsService } from '@/modules/globals/system-settings';
import { GoogleCloudStorageService } from '@/modules/google_cloud/google_bucket/bucket.service';
import { PriceService } from '@/modules/price/price.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly VLRM_HEX_ASSET_NAME: string;
  private readonly VLRM_POLICY_ID: string;
  private readonly isMainnet: boolean;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private readonly claimsRepository: Repository<Claim>,
    @InjectRepository(Snapshot)
    private readonly snapshotsRepository: Repository<Snapshot>,
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly priceService: PriceService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly gcsService: GoogleCloudStorageService
  ) {
    this.VLRM_HEX_ASSET_NAME = this.configService.get<string>('VLRM_HEX_ASSET_NAME');
    this.VLRM_POLICY_ID = this.configService.get<string>('VLRM_POLICY_ID');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

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

  /**
   * Create and save VLRM fee asset when vault is created
   */
  async addVLRMFeeAsset(vault: Vault, ownerId: string, transactionId: string): Promise<void> {
    // Check if VLRM creation is enabled and fee is greater than 0
    if (!this.systemSettingsService.vlrmCreatorFeeEnabled || this.systemSettingsService.vlrmCreatorFee <= 0) {
      this.logger.log(`VLRM creation disabled or fee is 0. Skipping VLRM asset creation for vault ${vault.id}`);
      return;
    }

    try {
      let vlrmDexPrice: number;

      if (this.isMainnet) {
        // Try to fetch current dex price for VLRM from DexHunter on mainnet
        try {
          const fetchedPrice = await this.dexHunterPricingService.getTokenPrice(
            `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`
          );
          vlrmDexPrice = fetchedPrice || 0;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.logger.warn(`Failed to fetch VLRM dex price from DexHunter: ${errorMessage}, using default: 0`);
          vlrmDexPrice = 0;
        }
      } else {
        // On testnet, use fixed default price of 5
        vlrmDexPrice = 5;
      }

      // Create VLRM fee asset
      const vlrmAsset = this.assetsRepository.create({
        vault_id: vault.id,
        policy_id: this.VLRM_POLICY_ID,
        asset_id: `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`,
        type: AssetType.FT,
        dex_price: vlrmDexPrice,
        quantity: this.systemSettingsService.vlrmCreatorFee,
        status: AssetStatus.LOCKED,
        origin_type: AssetOriginType.FEE,
        decimals: 4, // VLRM has 4 decimal places
        name: 'VLRM',
        last_valuation: new Date(),
        added_by: { id: ownerId },
        image: 'ipfs://QmdYu513Bu7nfKV5LKP6cmpZ8HHXifQLH6FTTzv3VbbqwP', // VLRM logo
        transaction: { id: transactionId },
        metadata: {
          purpose: 'vault_creation_fee',
        },
      });

      await this.assetsRepository.save(vlrmAsset);

      this.logger.log(
        `Created VLRM asset record for vault ${vault.id}: ${this.systemSettingsService.vlrmCreatorFee} tokens (dex_price: ${vlrmDexPrice} ADA)`
      );
      try {
        // Get all contributed and fee assets for the vault
        const assets = await this.assetsRepository.find({
          where: {
            vault_id: vault.id,
            deleted: false,
          },
        });

        const totalValueAda = assets.reduce((sum, asset) => sum + asset.valueAda, 0);

        // Update vault TVL
        vault.total_assets_cost_ada = totalValueAda;
        vault.total_assets_cost_usd = totalValueAda * (await this.priceService.getAdaPrice());

        await this.vaultsRepository.update(vault.id, {
          total_assets_cost_ada: vault.total_assets_cost_ada,
          total_assets_cost_usd: vault.total_assets_cost_usd,
        });
      } catch (error) {
        this.logger.error(`Failed to update vault totals after VLRM asset creation for vault ${vault.id}:`, error);
      }
    } catch (error) {
      this.logger.error(`Failed to create VLRM asset for vault ${vault.id}:`, error);
      throw error;
    }
  }

  async getVaultAssets(
    vaultId: string,
    page: number = 1,
    limit: number = 10,
    search: string = '',
    filter?: AssetsFilterDto
  ): Promise<GetContributedAssetsRes> {
    const { policyId, type } = filter || {};

    const queryBuilder = this.assetsRepository
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.added_by', 'user')
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
        'user.id',
        'user.address',
      ])
      .where('asset.vault_id = :vaultId', { vaultId })
      .andWhere('asset.origin_type IN (:...originTypes)', {
        originTypes: [AssetOriginType.CONTRIBUTED, AssetOriginType.BOUGHT, AssetOriginType.FEE],
      })
      .andWhere('asset.status IN (:...statuses)', {
        statuses: [
          AssetStatus.PENDING,
          AssetStatus.LOCKED,
          AssetStatus.EXTRACTED,
          AssetStatus.RELEASED,
          AssetStatus.LISTED,
        ],
      });

    if (search) {
      queryBuilder.andWhere('(asset.name ILIKE :search OR user.address ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (policyId && policyId.length > 0) {
      queryBuilder.andWhere('asset.policy_id IN (:...policyIds)', {
        policyIds: policyId,
      });
    }

    if (type) {
      queryBuilder.andWhere('asset.type = :type', { type });
    }

    // Calculate statistics with decimal adjustment
    const statsQuery = queryBuilder.clone();
    statsQuery
      .select(
        `SUM(
          CASE 
            WHEN asset.type = :ftType THEN 
              (asset.quantity / POWER(10, COALESCE(asset.decimals, 0))) * COALESCE(asset.dex_price, asset.floor_price, 0)
            ELSE 
              asset.quantity * COALESCE(asset.floor_price, asset.dex_price, 0)
          END
        )`,
        'totalValue'
      )
      .addSelect(`SUM(CASE WHEN asset.type = :nftType THEN asset.quantity ELSE 0 END)`, 'totalNFTAssets')
      .addSelect(
        `SUM(
          CASE 
            WHEN asset.type = :ftType THEN asset.quantity / POWER(10, COALESCE(asset.decimals, 0))
            ELSE 0 
          END
        )`,
        'totalFTAssets'
      )
      .setParameters({
        nftType: AssetType.NFT,
        ftType: AssetType.FT,
      });

    const rawStats = await statsQuery.getRawOne();
    const adjustedTotalValueAda = parseFloat(rawStats?.totalValue || '0');
    const totalNFTAssets = parseFloat(rawStats?.totalNFTAssets || '0');
    const adjustedTotalFTAssets = parseFloat(rawStats?.totalFTAssets || '0');

    const [assets, total] = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('asset.added_at', 'DESC')
      .getManyAndCount();

    const adaPrice = await this.priceService.getAdaPrice();

    const totalAssetValueUsd = adjustedTotalValueAda * adaPrice;
    // Calculate average per token (including all assets)
    const totalTokens = adjustedTotalFTAssets + totalNFTAssets;
    const assetsAvgAda = totalTokens > 0 ? adjustedTotalValueAda / totalTokens : 0;
    const assetsAvgUsd = assetsAvgAda * adaPrice;

    const assetsWithUsd = assets as Array<Asset & { floorPriceUsd?: number; valueUsd?: number }>;

    assetsWithUsd.forEach(asset => {
      const isNft = asset.type === AssetType.NFT;

      // Use the Asset entity getters for computed values
      // Note: normalizedQuantity and valueAda are now automatic via getters
      asset.valueUsd = asset.valueAda * adaPrice;

      // FloorPriceUsd is only for NFTs
      if (isNft && asset.floor_price) {
        asset.floorPriceUsd = asset.floor_price * adaPrice;
      }
    });

    const items = plainToInstance(AssetItemDto, assetsWithUsd, {
      excludeExtraneousValues: true,
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      statistics: {
        totalAssetValueAda: adjustedTotalValueAda,
        totalAssetValueUsd,
        assetsAvgAda,
        assetsAvgUsd,
        totalNFTAssets,
        totalFTAssets: adjustedTotalFTAssets,
      },
    };
  }

  async getAcquiredAssets(
    vaultId: string,
    page: number = 1,
    limit: number = 10,
    search?: string,
    minQuantity?: number,
    maxQuantity?: number
  ): Promise<GetAcquiredAssetsRes> {
    const vault = await this.vaultsRepository.exists({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }

    const queryBuilder = this.assetsRepository
      .createQueryBuilder('asset')
      .leftJoin('asset.transaction', 'transaction')
      .leftJoin('transaction.user', 'user')
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
        'user.id',
        'user.address',
      ])
      .where('asset.vault_id = :vaultId', { vaultId })
      .andWhere('asset.origin_type = :originType', {
        originType: AssetOriginType.ACQUIRED,
      })
      .andWhere('asset.status IN (:...statuses)', {
        statuses: [AssetStatus.LOCKED, AssetStatus.RELEASED, AssetStatus.DISTRIBUTED],
      });

    if (search) {
      queryBuilder.andWhere('user.address ILIKE :search', {
        search: `%${search}%`,
      });
    }

    if (minQuantity) {
      queryBuilder.andWhere('asset.quantity >= :minQuantity', {
        minQuantity,
      });
    }

    if (maxQuantity) {
      queryBuilder.andWhere('asset.quantity <= :maxQuantity', {
        maxQuantity,
      });
    }

    const statsResult = await queryBuilder
      .clone()
      .select('SUM(asset.quantity)', 'totalAcquired')
      .addSelect('COUNT(DISTINCT transaction.user_id)', 'totalAcquirers')
      .getRawOne();

    const totalAcquired = parseFloat(statsResult?.totalAcquired || '0');
    const totalAcquirers = parseInt(statsResult?.totalAcquirers || '0', 10);

    const [adaPrice, marketData, [assets, total]] = await Promise.all([
      this.priceService.getAdaPrice(),
      this.marketRepository.findOne({ where: { vault_id: vaultId } }),
      queryBuilder
        .skip((page - 1) * limit)
        .take(limit)
        .orderBy('asset.added_at', 'DESC')
        .getManyAndCount(),
    ]);

    const totalAcquiredUsd = totalAcquired * adaPrice;

    const totalAdaLiquidityAda = marketData?.totalAdaLiquidity != null ? Number(marketData.totalAdaLiquidity) : null;
    const totalAdaLiquidityUsd = totalAdaLiquidityAda != null ? totalAdaLiquidityAda * adaPrice : null;

    return {
      items: assets.map(asset => instanceToPlain(asset)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      totalAcquired,
      totalAcquiredUsd,
      totalAcquirers,
      totalAdaLiquidityAda,
      totalAdaLiquidityUsd,
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

  /**
   * Mark assets as distributed for given transactions
   * Idempotent - only updates assets that are LOCKED
   * Returns the number of assets actually updated
   */
  async markAssetsAsDistributedByTransactions(transactionIds: string[]): Promise<number> {
    if (transactionIds.length === 0) {
      return 0;
    }

    const assets = await this.assetsRepository.find({
      where: {
        transaction: { id: In(transactionIds) },
        deleted: false,
        status: AssetStatus.LOCKED, // Only locked assets can be distributed
      },
    });

    if (assets.length === 0) {
      // This is expected if assets were already marked via UTXO validation
      // Don't throw - just return 0
      return 0;
    }

    const result = await this.assetsRepository.update(
      {
        transaction: { id: In(transactionIds) },
        status: AssetStatus.LOCKED,
        deleted: false,
      },
      {
        status: AssetStatus.DISTRIBUTED,
      }
    );

    return result.affected || 0;
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

    // Fetch asset details before updating for event emission
    const assets = await this.assetsRepository.find({
      where: {
        id: In(assetIds),
        status: AssetStatus.LISTED,
        deleted: false,
      },
      relations: ['vault', 'vault.owner'],
      select: {
        id: true,
        name: true,
        listing_price: true,
        vault: {
          id: true,
          name: true,
          owner: {
            id: true,
            address: true,
          },
        },
      },
    });

    if (assets.length === 0) return;

    // Update asset status
    await this.assetsRepository.update(
      {
        id: In(assetIds),
        status: AssetStatus.LISTED, // Only listed assets can be sold
        deleted: false,
      },
      { status: AssetStatus.SOLD }
    );

    // Collect unique vault IDs from all assets
    const vaultIds = [...new Set(assets.map(asset => asset.vault?.id).filter(Boolean))];

    if (vaultIds.length === 0) return;

    // Fetch latest snapshots for all vaults in one query
    const snapshots = await this.snapshotsRepository
      .createQueryBuilder('snapshot')
      .select(['snapshot.id', 'snapshot.vaultId', 'snapshot.addressBalances', 'snapshot.createdAt'])
      .where('snapshot.vaultId IN (:...vaultIds)', { vaultIds })
      .orderBy('snapshot.createdAt', 'DESC')
      .getMany();

    // Create a map of vault_id -> latest snapshot
    const vaultSnapshotMap = new Map<string, Snapshot>();
    for (const snapshot of snapshots) {
      if (!vaultSnapshotMap.has(snapshot.vaultId)) {
        vaultSnapshotMap.set(snapshot.vaultId, snapshot);
      }
    }

    // Emit event for each sold asset
    for (const asset of assets) {
      if (!asset.vault) continue;

      const latestSnapshot = vaultSnapshotMap.get(asset.vault.id);

      // Extract addresses from snapshot
      const tokenHolderAddresses = latestSnapshot?.addressBalances
        ? Object.keys(latestSnapshot.addressBalances).filter(
            address => parseFloat(latestSnapshot.addressBalances[address]) > 0
          )
        : [];

      this.eventEmitter.emit('asset.sold', {
        assetId: asset.id,
        assetName: asset.name || 'Unknown Asset',
        salePrice: asset.listing_price || 0,
        vaultId: asset.vault.id,
        vaultName: asset.vault.name || 'Unknown Vault',
        ownerAddress: asset.vault.owner?.address || null,
        tokenHolderAddresses,
      });

      this.logger.log(
        `Emitted asset.sold event for asset ${asset.name} (${asset.id}) in vault ${asset.vault.name} to ${tokenHolderAddresses.length} token holders`
      );
    }
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to update asset valuations: ${errorMessage}`);
    }
  }

  async recordBoughtAsset(params: {
    vaultId: string;
    policyId: string;
    assetId: string;
    name: string;
    image?: string;
    floorPrice: number;
    metadata?: any;
    status?: AssetStatus;
  }): Promise<Asset> {
    const vault = await this.vaultsRepository.findOne({ where: { id: params.vaultId } });

    if (!vault) {
      throw new Error(`Vault ${params.vaultId} not found`);
    }

    let imageKey: string | null = null;
    if (params.image) {
      const fileKey = await this.gcsService.uploadAssetImage(params.image);
      if (fileKey) {
        imageKey = fileKey;
      } else {
        imageKey = params.image; // fallback to original URL if upload fails
      }
    }

    const asset = this.assetsRepository.create({
      vault,
      policy_id: params.policyId,
      asset_id: params.assetId,
      name: params.name,
      image: imageKey,
      type: AssetType.NFT,
      quantity: 1,
      floor_price: params.floorPrice,
      status: params.status ?? AssetStatus.LOCKED,
      origin_type: AssetOriginType.BOUGHT,
      added_by: null,
      metadata: params.metadata ?? null,
    });

    return this.assetsRepository.save(asset);
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
