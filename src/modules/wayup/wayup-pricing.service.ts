import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import {
  AnvilWalletAsset,
  AnvilWalletOffer,
  AnvilWalletOffersResponse,
  AnvilWalletAssetsResponse,
  GetCollectionAssetsQuery,
  GetCollectionAssetsResponse,
  OfferResolutionStatus,
} from './wayup.types';

import { Asset } from '@/database/asset.entity';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { AssetOriginType, AssetStatus } from '@/types/asset.types';

/**
 * WayUp Pricing Service - Handles only pricing queries without transaction building
 * This service is separate from WayUpService to avoid circular dependencies
 */
@Injectable()
export class WayUpPricingService {
  private readonly logger = new Logger(WayUpPricingService.name);
  private readonly baseUrl = 'https://prod.api.ada-anvil.app/marketplace/api/get-collection-assets';
  private readonly anvilMarketplaceApi: string;
  private readonly anvilApiKey: string;
  private readonly isMainnet: boolean;
  private readonly tapToolsApiKey: string;
  private readonly tapToolsApiUrl: string;
  private floorPriceCache = new NodeCache({ stdTTL: 300 }); // 5 minute cache for floor prices

  private isTrackingInProgress = false;
  private isOfferTrackingInProgress = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly assetsService: AssetsService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
    const anvilApiUrl = this.configService.get<string>('ANVIL_API_URL') ?? 'https://prod.api.ada-anvil.app/v2';
    this.anvilMarketplaceApi = `${anvilApiUrl.replace(/\/$/, '')}/services/marketplace`;
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY') ?? '';
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
    } catch (error: any) {
      this.logger.error(`Failed to fetch collection assets for policy ${query.policyId}`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch collection assets: ${errorMessage}`);
    }
  }

  /**
   * Fetch floor price from TapTools API as fallback
   * @param policyId - The policy ID of the NFT collection
   * @returns Floor price result or null if no data available
   */
  private async fetchFloorPriceFromTapTools(policyId: string): Promise<{
    floorPrice: number | null;
    floorPriceAda: number | null;
    hasListings: boolean;
  } | null> {
    try {
      const tapToolsResponse = await fetch(`${this.tapToolsApiUrl}/nft/collection/stats?policy=${policyId}`, {
        headers: {
          'x-api-key': this.tapToolsApiKey,
        },
      });

      if (!tapToolsResponse.ok) {
        const errorText = await tapToolsResponse.text();
        throw new Error(`TapTools API error: ${tapToolsResponse.status} ${tapToolsResponse.statusText} - ${errorText}`);
      }

      const tapToolsData = await tapToolsResponse.json();

      // TapTools returns price in ADA
      if (!tapToolsData.price || tapToolsData.price === 0) {
        this.logger.debug(`TapTools returned no floor price for collection ${policyId}`);
        return null;
      }

      const floorPriceAda = tapToolsData.price;
      const floorPriceLovelace = Math.round(floorPriceAda * 1_000_000);

      this.logger.log(
        `Successfully fetched floor price from TapTools for collection ${policyId}: ${floorPriceAda} ADA`
      );

      return {
        floorPrice: floorPriceLovelace,
        floorPriceAda,
        hasListings: tapToolsData.listings > 0,
      };
    } catch (error: any) {
      this.logger.warn(`TapTools API failed for collection ${policyId}`, error);
      return null;
    }
  }

  /**
   * Get the floor price for an NFT collection from WayUp Marketplace with TapTools fallback
   * Floor price is the lowest currently listed price in the collection
   * Results are cached for 5 minutes to reduce API calls
   *
   * Fallback strategy:
   * 1. Try WayUp API first
   * 2. If WayUp returns empty results, zero price, or fails - try TapTools API
   * 3. Return null only if both APIs fail or have no data
   *
   * @param policyId - The policy ID of the NFT collection
   * @returns Floor price in lovelace and ADA, or null if no listings exist
   */
  async getCollectionFloorPrice(policyId: string): Promise<{
    floorPrice: number | null; // lovelace
    floorPriceAda: number | null; // ADA
    hasListings: boolean;
  }> {
    // Check cache first
    const cacheKey = `floor_price_${policyId}`;
    const cached = this.floorPriceCache.get<{
      floorPrice: number | null;
      floorPriceAda: number | null;
      hasListings: boolean;
    }>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Skip API calls for testnet - WayUp doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping WayUp API call for testnet collection ${policyId}`);
      return {
        floorPrice: null,
        floorPriceAda: null,
        hasListings: false,
      };
    }

    let wayUpResult: { floorPrice: number | null; floorPriceAda: number | null; hasListings: boolean } | null = null;

    // Try WayUp API first
    try {
      const response = await this.getCollectionAssets({
        policyId,
        saleType: 'listedOnly',
        orderBy: 'priceAsc', // Sort by price ascending to get floor price first
        limit: 1,
      });

      if (response.results.length > 0 && response.results[0].listing) {
        const floorAsset = response.results[0];
        const floorPriceLovelace = floorAsset.listing.price;
        const floorPriceAda = floorPriceLovelace / 1_000_000;

        // Only use WayUp result if price is valid (non-zero)
        if (floorPriceLovelace > 0) {
          wayUpResult = {
            floorPrice: floorPriceLovelace,
            floorPriceAda,
            hasListings: true,
          };
        } else {
          this.logger.warn(`WayUp returned zero price for collection ${policyId}, trying TapTools fallback`);
        }
      } else {
        this.logger.debug(`WayUp returned no listings for collection ${policyId}, trying TapTools fallback`);
      }
    } catch (error: any) {
      this.logger.warn(`WayUp API failed for collection ${policyId}, trying TapTools fallback`, error);
    }

    // If WayUp succeeded with valid data, cache and return it
    if (wayUpResult) {
      this.floorPriceCache.set(cacheKey, wayUpResult);
      return wayUpResult;
    }

    // Fallback to TapTools API
    const tapToolsResult = await this.fetchFloorPriceFromTapTools(policyId);

    if (tapToolsResult) {
      this.floorPriceCache.set(cacheKey, tapToolsResult);
      return tapToolsResult;
    }

    // Both APIs failed or returned no data - cache the result to avoid repeated failed lookups
    this.logger.warn(`No floor price data available from WayUp or TapTools for collection ${policyId}`);
    const noDataResult = {
      floorPrice: null,
      floorPriceAda: null,
      hasListings: false,
    };
    this.floorPriceCache.set(cacheKey, noDataResult);
    return noDataResult;
  }

  /**
   * Fetch all sent offers for a treasury wallet from Anvil marketplace API.
   * @see https://prod.api.ada-anvil.app/v2/services/swagger/ui#tag/marketplace/GET/marketplace/wallets/{address}/offers
   */
  async getWalletSentOffers(walletAddress: string): Promise<AnvilWalletOffer[]> {
    if (!this.anvilApiKey) {
      throw new Error('ANVIL_API_KEY is not configured');
    }

    const allOffers: AnvilWalletOffer[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        direction: 'sent',
        limit: '60',
      });
      if (cursor) {
        params.append('cursor', cursor);
      }

      const response = await fetch(
        `${this.anvilMarketplaceApi}/wallets/${encodeURIComponent(walletAddress)}/offers?${params.toString()}`,
        {
          headers: {
            'x-api-key': this.anvilApiKey,
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anvil wallet offers API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data: AnvilWalletOffersResponse = await response.json();
      allOffers.push(...(data.results ?? []));
      cursor = data.cursor;
    } while (cursor);

    return allOffers;
  }

  /**
   * Fetch NFTs held by a treasury wallet from Anvil marketplace API.
   */
  async getWalletAssets(walletAddress: string): Promise<AnvilWalletAsset[]> {
    if (!this.anvilApiKey) {
      throw new Error('ANVIL_API_KEY is not configured');
    }

    const allAssets: AnvilWalletAsset[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: '60' });
      if (cursor) {
        params.append('cursor', cursor);
      }

      const response = await fetch(
        `${this.anvilMarketplaceApi}/wallets/${encodeURIComponent(walletAddress)}/assets?${params.toString()}`,
        {
          headers: {
            'x-api-key': this.anvilApiKey,
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anvil wallet assets API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data: AnvilWalletAssetsResponse = await response.json();
      allAssets.push(...(data.results ?? []));
      cursor = data.cursor;
    } while (cursor);

    return allAssets;
  }

  offerAssetKey(policyId: string, assetName: string): string {
    return `${policyId.toLowerCase()}:${assetName.toLowerCase()}`;
  }

  /**
   * Resolve a single vault offer against live Anvil marketplace state.
   */
  async getVaultOfferMarketplaceState(
    treasuryAddress: string,
    policyId: string,
    assetNameHex: string
  ): Promise<OfferResolutionStatus> {
    const [sentOffers, treasuryAssets] = await Promise.all([
      this.getWalletSentOffers(treasuryAddress),
      this.getWalletAssets(treasuryAddress),
    ]);

    const activeOfferKeys = new Set(sentOffers.map(offer => this.offerAssetKey(offer.policyId, offer.assetName)));
    const treasuryAssetKeys = new Set(treasuryAssets.map(asset => this.offerAssetKey(asset.policyId, asset.assetName)));

    return this.resolveOfferStatus(policyId, assetNameHex, activeOfferKeys, treasuryAssetKeys);
  }

  getOfferResolutionUserMessage(state: OfferResolutionStatus, assetLabel: string): string {
    switch (state) {
      case 'active':
        return `Offer for ${assetLabel} is active on WayUp.`;
      case 'accepted':
        return `Offer for ${assetLabel} was already accepted — the NFT is in the treasury wallet.`;
      case 'cancelled':
        return `Offer for ${assetLabel} is no longer active on WayUp (cancelled or expired).`;
    }
  }

  /**
   * Determine whether a vault offer is still active, was accepted, or was cancelled.
   */
  resolveOfferStatus(
    policyId: string,
    assetNameHex: string,
    activeOfferKeys: Set<string>,
    treasuryAssetKeys: Set<string>
  ): OfferResolutionStatus {
    const key = this.offerAssetKey(policyId, assetNameHex);

    if (activeOfferKeys.has(key)) {
      return 'active';
    }

    if (treasuryAssetKeys.has(key)) {
      return 'accepted';
    }

    return 'cancelled';
  }

  /**
   * Reconcile active offers in the database with Anvil marketplace state.
   * - Active sent offer → keep OFFERED status / OFFERED origin
   * - Offer gone + NFT in treasury → accepted → BOUGHT origin + EXTRACTED status
   * - Offer gone + NFT not in treasury → cancelled → CANCEL_OFFER status
   */
  async syncOfferStatuses(): Promise<{
    checked: number;
    accepted: number;
    cancelled: number;
    stillActive: number;
  }> {
    const offeredAssets = await this.assetRepository.find({
      where: {
        status: AssetStatus.OFFERED,
        origin_type: AssetOriginType.OFFERED,
        deleted: false,
      },
      relations: ['vault', 'vault.treasury_wallet'],
      select: {
        id: true,
        policy_id: true,
        asset_id: true,
        name: true,
        vault_id: true,
        vault: {
          id: true,
          treasury_wallet: {
            treasury_address: true,
          },
        },
      },
    });

    if (offeredAssets.length === 0) {
      return { checked: 0, accepted: 0, cancelled: 0, stillActive: 0 };
    }

    const assetsByTreasury = new Map<string, Asset[]>();

    for (const asset of offeredAssets) {
      const treasuryAddress = asset.vault?.treasury_wallet?.treasury_address;
      if (!treasuryAddress) {
        this.logger.warn(`Skipping offer asset ${asset.id}: vault ${asset.vault_id} has no treasury wallet`);
        continue;
      }

      const group = assetsByTreasury.get(treasuryAddress) ?? [];
      group.push(asset);
      assetsByTreasury.set(treasuryAddress, group);
    }

    const acceptedIds: string[] = [];
    const cancelledIds: string[] = [];
    let stillActive = 0;

    for (const [treasuryAddress, assets] of assetsByTreasury) {
      try {
        const [sentOffers, treasuryAssets] = await Promise.all([
          this.getWalletSentOffers(treasuryAddress),
          this.getWalletAssets(treasuryAddress),
        ]);

        const activeOfferKeys = new Set(sentOffers.map(offer => this.offerAssetKey(offer.policyId, offer.assetName)));
        const treasuryAssetKeys = new Set(
          treasuryAssets.map(asset => this.offerAssetKey(asset.policyId, asset.assetName))
        );

        for (const asset of assets) {
          const resolution = this.resolveOfferStatus(
            asset.policy_id,
            asset.asset_id,
            activeOfferKeys,
            treasuryAssetKeys
          );

          switch (resolution) {
            case 'active':
              stillActive++;
              break;
            case 'accepted':
              acceptedIds.push(asset.id);
              this.logger.log(
                `Offer accepted for "${asset.name}" (${asset.policy_id}${asset.asset_id}) in treasury ${treasuryAddress}`
              );
              break;
            case 'cancelled':
              cancelledIds.push(asset.id);
              this.logger.log(
                `Offer cancelled for "${asset.name}" (${asset.policy_id}${asset.asset_id}) from treasury ${treasuryAddress}`
              );
              break;
          }
        }
      } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to sync offer statuses for treasury ${treasuryAddress}: ${errorMessage}`,
          error instanceof Error ? error.stack : undefined
        );
      }
    }

    if (acceptedIds.length > 0) {
      await this.assetsService.markOffersAsAccepted(acceptedIds);
    }

    if (cancelledIds.length > 0) {
      await this.assetsService.markOffersAsCancelled(cancelledIds);
    }

    return {
      checked: offeredAssets.length,
      accepted: acceptedIds.length,
      cancelled: cancelledIds.length,
      stillActive,
    };
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
        } catch (error: any) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to check sale status for asset ${asset.name} (${asset.asset_id}): ${errorMessage}`);
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
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`NFT sale tracking cron job failed: ${errorMessage}`, errorStack);
    } finally {
      // Release lock
      this.isTrackingInProgress = false;
    }
  }

  /**
   * Cron job that reconciles OFFERED assets with Anvil marketplace wallet offers.
   * Detects accepted offers (NFT in treasury) and cancelled offers (no longer sent).
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async trackOfferStatuses(): Promise<void> {
    if (!this.isMainnet) {
      this.logger.debug('Skipping offer status tracking for testnet');
      return;
    }

    if (!this.anvilApiKey) {
      this.logger.warn('Skipping offer status tracking: ANVIL_API_KEY is not configured');
      return;
    }

    if (this.isOfferTrackingInProgress) {
      this.logger.warn('Offer status tracking is already in progress, skipping this execution');
      return;
    }

    this.isOfferTrackingInProgress = true;

    try {
      const result = await this.syncOfferStatuses();

      if (result.checked === 0) {
        this.logger.log('No offered assets found to track');
        return;
      }

      this.logger.log(
        `Offer status tracking completed: checked=${result.checked}, active=${result.stillActive}, ` +
          `accepted=${result.accepted}, cancelled=${result.cancelled}`
      );
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Offer status tracking cron job failed: ${errorMessage}`, errorStack);
    } finally {
      this.isOfferTrackingInProgress = false;
    }
  }
}
