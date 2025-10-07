import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain } from 'class-transformer';
import { Repository } from 'typeorm';

import { CreateAssetDto } from './dto/create-asset.dto';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class AssetsService {
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
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Verify vault ownership
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: vaultId,
      },
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }
    let queryBuilder = this.assetsRepository
      .createQueryBuilder('asset')
      .where('asset.vault_id = :vaultId', { vaultId })
      .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
      .andWhere('asset.status = :status', {
        status: AssetStatus.LOCKED,
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
  async getAcquiredAssets(
    vaultId: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Verify vault ownership
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: vaultId,
      },
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
        status: AssetStatus.LOCKED,
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

  async releaseAssetByClaimId(claimId: string): Promise<void> {
    const claimWithAsset = await this.claimsRepository
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
      .where('claim.id = :claimId', { claimId })
      .andWhere('asset.deleted = false')
      .getOne();

    if (!claimWithAsset) {
      throw new BadRequestException('Claim not found or no associated asset');
    }

    const asset = claimWithAsset.transaction.assets[0];

    if (!asset) {
      throw new BadRequestException('No asset associated with this claim');
    }

    if (asset.status !== AssetStatus.LOCKED) {
      throw new BadRequestException(
        `Asset cannot be released. Current status: ${asset.status}. Only locked assets can be released.`
      );
    }

    const now = new Date();
    await this.assetsRepository.update(
      { id: asset.id },
      {
        status: AssetStatus.RELEASED,
        released_at: now,
        updated_at: now,
      }
    );
  }

  async updateAssetValuation(
    userId: string,
    assetId: string,
    floorPrice?: number,
    dexPrice?: number
  ): Promise<Record<string, unknown>> {
    const asset = await this.assetsRepository.findOne({
      where: { id: assetId },
      relations: ['vault', 'vault.owner'],
    });

    if (!asset || asset.vault.owner.id !== userId) {
      throw new BadRequestException('Asset not found or access denied');
    }

    if (asset.vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Asset valuations can only be updated during the contribution phase');
    }

    if (asset.type === AssetType.NFT && floorPrice !== undefined) {
      asset.floor_price = floorPrice;
    }

    if (asset.type === AssetType.FT && dexPrice !== undefined) {
      asset.dex_price = dexPrice;
    }

    asset.last_valuation = new Date();
    await this.assetsRepository.save(asset);
    return instanceToPlain(asset);
  }

  /**
   * Updates asset prices and last valuation timestamp after calculation
   * @param assets List of assets with updated price information
   */
  async updateAssetValuations(
    assets: Array<{
      policyId: string;
      isNft: boolean;
      assetId: string;
      valueAda: number;
    }>
  ): Promise<void> {
    try {
      for (const asset of assets) {
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
      }
    } catch (error) {
      throw new Error(`Failed to update asset valuations: ${error.message}`);
    }
  }

  async updateTransactionAssets(transactionId: string, vaultId: string): Promise<void> {
    const assets = await this.assetsRepository.find({
      where: {
        transaction: { id: transactionId },
      },
    });

    if (!assets.length) {
      return;
    }

    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new BadRequestException(`Vault with id ${vaultId} not found`);
    }

    // Update all assets to be linked to the vault
    await Promise.all(
      assets.map(async asset => {
        asset.vault = vault;
        asset.status = AssetStatus.LOCKED;
        asset.locked_at = new Date();
        return this.assetsRepository.save(asset);
      })
    );
  }

  async cancelAsset(assetId: string, userId: string): Promise<void> {
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
