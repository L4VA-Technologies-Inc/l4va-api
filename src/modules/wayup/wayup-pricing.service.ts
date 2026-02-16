import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GetCollectionAssetsQuery, GetCollectionAssetsResponse } from './wayup.types';

import { Asset } from '@/database/asset.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { AssetStatus } from '@/types/asset.types';

/**
 * WayUp Pricing Service - Handles only pricing queries without transaction building
 * This service is separate from WayUpService to avoid circular dependencies
 */
@Injectable()
export class WayUpPricingService {
  private readonly logger = new Logger(WayUpPricingService.name);
  private readonly baseUrl = 'https://prod.api.ada-anvil.app/marketplace/api/get-collection-assets';
  private readonly isMainnet: boolean;
  private isTrackingInProgress = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly assetsService: AssetsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Get collection assets with pricing from WayUp Marketplace
   * Retrieves NFTs from a collection with optional filtering by price, rarity, and asset name
   *
   * @param query - Query parameters for filtering and pagination
   * @returns Collection assets with listing information
   */
  async getCollectionAssets(query: GetCollectionAssetsQuery): Promise<GetCollectionAssetsResponse> {
    // Build query parameters
    const params = new URLSearchParams();
    params.append('policyId', query.policyId);

    if (query.limit) params.append('limit', query.limit.toString());
    if (query.cursor) params.append('cursor', query.cursor);
    if (query.minPrice) params.append('minPrice', query.minPrice);
    if (query.maxPrice) params.append('maxPrice', query.maxPrice);
    if (query.minRarity) params.append('minRarity', query.minRarity);
    if (query.maxRarity) params.append('maxRarity', query.maxRarity);
    if (query.orderBy) params.append('orderBy', query.orderBy);
    if (query.term) params.append('term', query.term);
    if (query.listingType) params.append('listingType', query.listingType);
    if (query.saleType) params.append('saleType', query.saleType);
    if (query.properties) {
      query.properties.forEach(prop => {
        params.append('properties', JSON.stringify(prop));
      });
    }

    try {
      const response = await fetch(`${this.baseUrl}?${params.toString()}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`WayUp API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data: GetCollectionAssetsResponse = await response.json();

      return data;
    } catch (error) {
      this.logger.error(`Failed to fetch collection assets for policy ${query.policyId}`, error);
      throw new Error(`Failed to fetch collection assets: ${error.message}`);
    }
  }

  /**
   * Get the floor price for an NFT collection from WayUp Marketplace
   * Floor price is the lowest currently listed price in the collection
   *
   * @param policyId - The policy ID of the NFT collection
   * @returns Floor price in lovelace and ADA, or null if no listings exist
   */
  async getCollectionFloorPrice(policyId: string): Promise<{
    floorPrice: number | null; // lovelace
    floorPriceAda: number | null; // ADA
    hasListings: boolean;
  }> {
    // Skip API calls for testnet - WayUp doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping WayUp API call for testnet collection ${policyId}`);
      return {
        floorPrice: null,
        floorPriceAda: null,
        hasListings: false,
      };
    }

    try {
      // Query the collection for the cheapest listing
      const response = await this.getCollectionAssets({
        policyId,
        saleType: 'listedOnly',
        orderBy: 'priceAsc', // Sort by price ascending to get floor price first
        limit: 1,
      });

      if (response.results.length === 0 || !response.results[0].listing) {
        return {
          floorPrice: null,
          floorPriceAda: null,
          hasListings: false,
        };
      }

      const floorAsset = response.results[0];
      const floorPriceLovelace = floorAsset.listing.price;
      const floorPriceAda = floorPriceLovelace / 1_000_000;

      return {
        floorPrice: floorPriceLovelace,
        floorPriceAda,
        hasListings: true,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch floor price for collection ${policyId}`, error);
      throw new Error(`Failed to fetch floor price: ${error.message}`);
    }
  }

  /**
   * Cron job that tracks NFT sales by checking if LISTED assets are still on WayUp
   * Implements locking mechanism to prevent concurrent executions
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async trackNFTSales(): Promise<void> {
    // Skip for testnet - WayUp doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug('Skipping NFT sale tracking for testnet');
      return;
    }

    // Check if tracking is already in progress
    if (this.isTrackingInProgress) {
      this.logger.warn('NFT sale tracking is already in progress, skipping this execution');
      return;
    }

    // Acquire lock
    this.isTrackingInProgress = true;

    try {
      // Query all LISTED assets
      const listedAssets = await this.assetRepository.find({
        where: {
          status: AssetStatus.LISTED,
          deleted: false,
        },
        select: ['id', 'policy_id', 'asset_id', 'name'],
      });

      if (listedAssets.length === 0) {
        this.logger.log('No listed assets found to track');
        return;
      }

      this.logger.log(`Found ${listedAssets.length} listed assets to check`);

      const soldAssetIds: string[] = [];

      // Check each asset individually
      for (const asset of listedAssets) {
        try {
          // Query for the specific asset by name
          const response = await this.getCollectionAssets({
            policyId: asset.policy_id,
            term: asset.name,
            limit: 1,
          });

          // If the response is empty or has no listing, the asset was sold
          if (response.results.length === 0 || !response.results[0].listing) {
            soldAssetIds.push(asset.id);
            this.logger.log(`Asset ${asset.name} (${asset.asset_id}) from policy ${asset.policy_id} has been sold`);
          }
        } catch (error) {
          this.logger.error(
            `Failed to check sale status for asset ${asset.name} (${asset.asset_id}): ${error.message}`
          );
          // Continue with next asset
        }
      }

      // Mark sold assets
      if (soldAssetIds.length > 0) {
        await this.assetsService.markAssetsAsSold(soldAssetIds);
        this.logger.log(`Marked ${soldAssetIds.length} assets as SOLD`);
      } else {
        this.logger.log('No assets were sold since last check');
      }

      this.logger.log('NFT sale tracking cron job completed successfully');
    } catch (error) {
      this.logger.error(`NFT sale tracking cron job failed: ${error.message}`, error.stack);
    } finally {
      // Release lock
      this.isTrackingInProgress = false;
    }
  }
}
