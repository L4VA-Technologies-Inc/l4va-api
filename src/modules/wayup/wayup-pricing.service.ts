import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { GetCollectionAssetsQuery, GetCollectionAssetsResponse } from './wayup.types';

/**
 * WayUp Pricing Service - Handles only pricing queries without transaction building
 * This service is separate from WayUpService to avoid circular dependencies
 */
@Injectable()
export class WayUpPricingService {
  private readonly logger = new Logger(WayUpPricingService.name);
  private readonly baseUrl = 'https://prod.api.ada-anvil.app/marketplace/api/get-collection-assets';
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
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
}
