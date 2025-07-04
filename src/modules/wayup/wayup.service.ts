import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';

import { CreateListingDto } from './dto/create-listing.dto';

import { Asset } from '@/database/asset.entity';
import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class WayupService {
  private readonly logger = new Logger(WayupService.name);
  private readonly wayupApiUrl: string;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly configService: ConfigService
  ) {
    this.wayupApiUrl =
      this.configService.get<string>('WAYUP_API_URL') || 'https://prod.api.ada-anvil.app/marketplace/api';
  }

  /**
   * Creates an asset listing from vault on Way-up
   */
  async createAssetListing(
    vaultId: string,
    assetId: string,
    userId: string,
    listingData: CreateListingDto
  ): Promise<{
    success: boolean;
    transactions: string[];
  }> {
    // Access rights validation
    const vault = await this.validateVaultAccess(vaultId, userId);
    const asset = await this.validateAssetInVault(assetId, vaultId);

    try {
      const assetNameHex = asset.asset_id; // NFT_ASSET_NAME_HEX

      const wayupListingData = {
        changeAddress: vault.contract_address, // Vault address as change address
        utxos: listingData.utxos, // UTXOs containing the NFT - should come from frontend
        create: [
          {
            assets: {
              policyId: asset.policy_id,
              assetName: assetNameHex,
            },
            priceAda: listingData.price,
          },
        ],
      };

      this.logger.log(
        `Creating Way-up listing for asset ${asset.policy_id}.${assetNameHex} at ${listingData.price} ADA`
      );

      const response = await axios.post(`${this.wayupApiUrl}/build-tx`, wayupListingData, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // Update asset status
      await this.assetRepository.update(assetId, {
        status: AssetStatus.LISTED_FOR_SALE,
        metadata: {
          ...asset.metadata,
          wayup_transactions: response.data.transactions,
          listing_price: listingData.price,
          listed_at: new Date().toISOString(),
        },
      });

      this.logger.log(`Asset ${assetId} from vault ${vaultId} listed on Way-up`);

      return {
        success: true,
        transactions: response.data.transactions,
      };
    } catch (error) {
      this.logger.error(`Failed to create Way-up listing: ${error.message}`);
      throw new BadRequestException('Failed to create listing on Way-up');
    }
  }

  /**
   * Submits signed listing transaction to Way-up
   */
  async submitListingTransaction(
    assetId: string,
    signedData: { transaction: string; signature: string }
  ): Promise<{
    success: boolean;
    result: unknown;
  }> {
    try {
      const response = await axios.post(
        `${this.wayupApiUrl}/submit`,
        {
          transaction: signedData.transaction.trim(),
          signature: signedData.signature.trim(),
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      // Update asset metadata with submission result
      const asset = await this.assetRepository.findOne({ where: { id: assetId } });
      if (asset) {
        await this.assetRepository.update(assetId, {
          metadata: {
            ...asset.metadata,
            wayup_submitted_at: new Date().toISOString(),
            wayup_submission_result: response.data,
            wayup_tx_hash: response.data?.result?.data?.txHash,
          },
        });
      }

      return {
        success: true,
        result: response.data,
      };
    } catch (error) {
      this.logger.error(`Failed to submit listing transaction: ${error.message}`);
      throw new BadRequestException('Failed to submit listing transaction');
    }
  }

  /**
   * Gets assets available for listing from vault
   */
  async getListableAssets(vaultId: string): Promise<Asset[]> {
    return this.assetRepository.find({
      where: {
        vault: { id: vaultId },
        status: AssetStatus.LOCKED, // Only locked assets can be listed
        origin_type: AssetOriginType.CONTRIBUTED, // Only contributed assets
      },
    });
  }

  private async validateVaultAccess(vaultId: string, userId: string): Promise<Vault> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['owner'],
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    if (vault.owner.id !== userId) {
      throw new BadRequestException('You are not the owner of this vault');
    }

    if (vault.vault_status !== VaultStatus.locked) {
      throw new BadRequestException('Only locked vaults can list assets');
    }

    return vault;
  }

  private async validateAssetInVault(assetId: string, vaultId: string): Promise<Asset> {
    const asset = await this.assetRepository.findOne({
      where: {
        id: assetId,
        vault: { id: vaultId },
      },
    });

    if (!asset) {
      throw new BadRequestException('Asset not found in this vault');
    }

    if (asset.status === AssetStatus.LISTED_FOR_SALE) {
      throw new BadRequestException('Asset is already listed for sale');
    }

    return asset;
  }
}
