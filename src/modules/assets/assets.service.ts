import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset } from '../../database/asset.entity';
import { Vault } from '../../database/vault.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { AssetStatus, AssetType } from '../../types/asset.types';
import { VaultStatus } from '../../types/vault.types';
import { classToPlain } from 'class-transformer';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>
  ) {}

  async addAssetToVault(userId: string, data: CreateAssetDto): Promise<any> {
    const vault = await this.vaultsRepository.findOne({
      where: { 
        id: data.vaultId,
        owner: { id: userId }
      }
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }

    if (vault.vault_status !== VaultStatus.contribution) {
      throw new BadRequestException('Assets can only be added during the contribution phase');
    }

    // Validate asset type-specific requirements
    if (data.type === AssetType.NFT && !data.tokenId) {
      throw new BadRequestException('Token ID is required for NFT assets');
    }

    if (data.type === AssetType.CNT && !data.dexPrice) {
      throw new BadRequestException('DEX price is required for CNT assets');
    }

    // Create and save the asset
    const asset = this.assetsRepository.create({
      vault_id: data.vaultId,
      type: data.type,
      contract_address: data.contractAddress,
      token_id: data.tokenId,
      quantity: data.quantity,
      floor_price: data.floorPrice,
      dex_price: data.dexPrice,
      last_valuation: new Date(),
      status: AssetStatus.PENDING,
      metadata: data.metadata,
      added_by: userId
    });

    await this.assetsRepository.save(asset);
    return classToPlain(asset);
  }

  async getVaultAssets(userId: string, vaultId: string, page: number = 1, limit: number = 10): Promise<any> {
    // Verify vault ownership
    const vault = await this.vaultsRepository.findOne({
      where: { 
        id: vaultId,
        owner: { id: userId }
      }
    });

    if (!vault) {
      throw new BadRequestException('Vault not found or access denied');
    }

    const [assets, total] = await this.assetsRepository.findAndCount({
      where: { vault_id: vaultId },
      skip: (page - 1) * limit,
      take: limit,
      order: {
        added_at: 'DESC'
      }
    });

    return {
      items: assets.map(asset => classToPlain(asset)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async lockAsset(userId: string, assetId: string): Promise<any> {
    const asset = await this.assetsRepository.findOne({
      where: { id: assetId },
      relations: ['vault', 'vault.owner']
    });

    if (!asset || asset.vault.owner.id !== userId) {
      throw new BadRequestException('Asset not found or access denied');
    }

    if (asset.status !== AssetStatus.PENDING) {
      throw new BadRequestException('Only pending assets can be locked');
    }

    asset.status = AssetStatus.LOCKED;
    asset.locked_at = new Date();

    await this.assetsRepository.save(asset);
    return classToPlain(asset);
  }

  async releaseAsset(userId: string, assetId: string): Promise<any> {
    const asset = await this.assetsRepository.findOne({
      where: { id: assetId },
      relations: ['vault', 'vault.owner']
    });

    if (!asset || asset.vault.owner.id !== userId) {
      throw new BadRequestException('Asset not found or access denied');
    }

    if (asset.status !== AssetStatus.LOCKED) {
      throw new BadRequestException('Only locked assets can be released');
    }

    asset.status = AssetStatus.RELEASED;
    asset.released_at = new Date();

    await this.assetsRepository.save(asset);
    return classToPlain(asset);
  }

  async updateAssetValuation(userId: string, assetId: string, floorPrice?: number, dexPrice?: number): Promise<any> {
    const asset = await this.assetsRepository.findOne({
      where: { id: assetId },
      relations: ['vault', 'vault.owner']
    });

    if (!asset || asset.vault.owner.id !== userId) {
      throw new BadRequestException('Asset not found or access denied');
    }

    if (asset.type === AssetType.NFT && floorPrice !== undefined) {
      asset.floor_price = floorPrice;
    }

    if (asset.type === AssetType.CNT && dexPrice !== undefined) {
      asset.dex_price = dexPrice;
    }

    asset.last_valuation = new Date();
    await this.assetsRepository.save(asset);
    return classToPlain(asset);
  }
}
