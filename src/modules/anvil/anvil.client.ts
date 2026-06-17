import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';
import { firstValueFrom } from 'rxjs';

/** Collection summary from Anvil marketplace */
export interface AnvilCollection {
  name: string;
  floorPrice: number; // ADA
  listed: number;
  totalVolume: number; // ADA
}

/** Single asset listing */
export interface AnvilAssetListing {
  price: number; // ADA
  assetName: string;
}

/** Asset attributes / traits */
export type AnvilAssetAttributes = Record<string, string>;

/** Trait floor prices: traitValue → floor price in ADA */
export type AnvilTraitPrices = Record<string, number>;

interface AnvilCollectionResponse {
  name?: string;
  floorPrice?: string | number; // lovelace
  listed?: number;
  totalVolume?: string | number; // lovelace
}

interface AnvilAssetListingResponse {
  price?: string | number; // lovelace
}

interface AnvilAssetAttributesResponse {
  attributes?: Record<string, string>;
}

interface AnvilCollectionAssetsResponse {
  assets?: Array<{
    assetName?: string;
    listing?: { price?: string | number };
    attributes?: Record<string, string>;
  }>;
  nextCursor?: string;
}

const LOVELACE = 1_000_000;

/**
 * Anvil API client for NFT marketplace data.
 * Provides NFT collection floor prices, asset attributes/traits, and
 * derived trait-based pricing (by sampling active marketplace listings).
 *
 * Base URL: https://prod.api.ada-anvil.app/v2/services
 * Auth: x-api-key header
 */
@Injectable()
export class AnvilClient {
  private readonly logger = new Logger(AnvilClient.name);
  private readonly anvilApiUrl: string;
  private readonly anvilApiKey: string;

  /** Collection floor price — 10 min TTL */
  private readonly collectionCache: NodeCache;
  /** Asset attributes — 30 min TTL */
  private readonly attributesCache: NodeCache;
  /** Derived trait prices — 15 min TTL */
  private readonly traitPricesCache: NodeCache;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.anvilApiUrl = this.configService.get<string>('ANVIL_API_URL') || 'https://prod.api.ada-anvil.app/v2/services';
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY') || '';

    this.collectionCache = new NodeCache({ stdTTL: 600, checkperiod: 120, useClones: false });
    this.attributesCache = new NodeCache({ stdTTL: 1800, checkperiod: 300, useClones: false });
    this.traitPricesCache = new NodeCache({ stdTTL: 900, checkperiod: 120, useClones: false });
  }

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.anvilApiKey };
  }

  private lovelaceToAda(value: string | number | undefined): number {
    if (value === undefined || value === null) return 0;
    return Number(value) / LOVELACE;
  }

  // ─── Collection ─────────────────────────────────────────────────────────────

  /**
   * Get collection summary including current floor price.
   *
   * @param policyId - NFT collection policy ID
   */
  async getCollection(policyId: string): Promise<AnvilCollection | null> {
    const cacheKey = `collection_${policyId}`;
    const cached = this.collectionCache.get<AnvilCollection>(cacheKey);
    if (cached) return cached;

    try {
      const res = await firstValueFrom(
        this.httpService.get<AnvilCollectionResponse>(`${this.anvilApiUrl}/marketplace/collections/${policyId}`, {
          headers: this.headers,
          timeout: 10000,
        })
      );

      const data = res.data;
      if (!data) return null;

      const result: AnvilCollection = {
        name: data.name || policyId,
        floorPrice: this.lovelaceToAda(data.floorPrice),
        listed: data.listed || 0,
        totalVolume: this.lovelaceToAda(data.totalVolume),
      };

      this.collectionCache.set(cacheKey, result);
      return result;
    } catch (error) {
      if ((error as any)?.response?.status !== 404) {
        this.logger.debug(
          `Anvil: failed to get collection ${policyId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * Get current floor price for a collection in ADA.
   * Convenience wrapper around getCollection().
   */
  async getCollectionFloorPrice(policyId: string): Promise<number | null> {
    const collection = await this.getCollection(policyId);
    if (!collection || collection.floorPrice <= 0) return null;
    return collection.floorPrice;
  }

  // ─── Asset Attributes ────────────────────────────────────────────────────────

  /**
   * Get attributes/traits for a specific NFT asset.
   *
   * @param policyId  - Collection policy ID
   * @param assetName - Hex-encoded asset name
   */
  async getAssetAttributes(policyId: string, assetName: string): Promise<AnvilAssetAttributes | null> {
    const cacheKey = `attrs_${policyId}_${assetName}`;
    const cached = this.attributesCache.get<AnvilAssetAttributes>(cacheKey);
    if (cached) return cached;

    try {
      const res = await firstValueFrom(
        this.httpService.get<AnvilAssetAttributesResponse>(
          `${this.anvilApiUrl}/marketplace/collections/${policyId}/assets/${assetName}/attributes`,
          { headers: this.headers, timeout: 10000 }
        )
      );

      const attrs = res.data?.attributes;
      if (!attrs || !Object.keys(attrs).length) return null;

      this.attributesCache.set(cacheKey, attrs);
      return attrs;
    } catch {
      return null;
    }
  }

  /**
   * Get listing price for a specific NFT asset.
   *
   * @param policyId  - Collection policy ID
   * @param assetName - Hex-encoded asset name
   * @returns Price in ADA or null if not listed
   */
  async getAssetListingPrice(policyId: string, assetName: string): Promise<number | null> {
    try {
      const res = await firstValueFrom(
        this.httpService.get<AnvilAssetListingResponse>(
          `${this.anvilApiUrl}/marketplace/collections/${policyId}/assets/${assetName}/listing`,
          { headers: this.headers, timeout: 10000 }
        )
      );

      const price = this.lovelaceToAda(res.data?.price);
      return price > 0 ? price : null;
    } catch {
      return null; // Not listed
    }
  }

  // ─── Trait Price Derivation ──────────────────────────────────────────────────

  /**
   * Derive floor prices per trait value from active marketplace listings.
   * Samples up to `sampleSize` listed assets and groups their listing prices
   * by the specified trait name. Returns the floor (minimum) price per trait value.
   *
   * Example: traitName='Character' → { 'Exploratur': 280, 'Phoenix': 195, 'Balaena': 135 }
   *
   * @param policyId  - NFT collection policy ID
   * @param traitName - Trait attribute name to group by (default: 'Character')
   * @param sampleSize - Max listed assets to sample (default: 50)
   */
  async deriveTraitFloorPrices(
    policyId: string,
    traitName: string = 'Character',
    sampleSize: number = 50
  ): Promise<AnvilTraitPrices | null> {
    const cacheKey = `trait_prices_${policyId}_${traitName}`;
    const cached = this.traitPricesCache.get<AnvilTraitPrices>(cacheKey);
    if (cached) return cached;

    try {
      // Get listed assets (includes inline listing price when available)
      const res = await firstValueFrom(
        this.httpService.get<AnvilCollectionAssetsResponse>(
          `${this.anvilApiUrl}/marketplace/collections/${policyId}/assets`,
          {
            headers: this.headers,
            params: { listed: true, limit: sampleSize },
            timeout: 15000,
          }
        )
      );

      const assets = res.data?.assets;
      if (!assets?.length) return null;

      // Group prices by trait value
      const pricesByTrait: Record<string, number[]> = {};

      // Fetch attributes for each asset in parallel (max 5 concurrent)
      const CONCURRENCY = 5;
      for (let i = 0; i < assets.length; i += CONCURRENCY) {
        const batch = assets.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async asset => {
            if (!asset.assetName) return;

            // Get listing price (inline or via separate call)
            let price: number | null = null;
            if (asset.listing?.price) {
              price = this.lovelaceToAda(asset.listing.price);
            } else {
              price = await this.getAssetListingPrice(policyId, asset.assetName);
            }
            if (!price || price <= 0) return;

            // Get trait value (inline or via separate call)
            let traitValue: string | undefined;
            if (asset.attributes) {
              traitValue = asset.attributes[traitName];
            } else {
              const attrs = await this.getAssetAttributes(policyId, asset.assetName);
              traitValue = attrs?.[traitName];
            }

            if (!traitValue) return;

            if (!pricesByTrait[traitValue]) pricesByTrait[traitValue] = [];
            pricesByTrait[traitValue].push(price);
          })
        );
      }

      if (!Object.keys(pricesByTrait).length) return null;

      // Return floor price (minimum) per trait value
      const result: AnvilTraitPrices = {};
      for (const [trait, prices] of Object.entries(pricesByTrait)) {
        result[trait] = Math.min(...prices);
      }

      this.traitPricesCache.set(cacheKey, result);
      this.logger.log(`Anvil: derived trait prices for ${policyId} (${Object.keys(result).length} traits)`);
      return result;
    } catch (error) {
      this.logger.debug(
        `Anvil: failed to derive trait prices for ${policyId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  // ─── Cache utilities ────────────────────────────────────────────────────────

  clearCache(): void {
    [this.collectionCache, this.attributesCache, this.traitPricesCache].forEach(c => c.flushAll());
    this.logger.log('Cleared Anvil caches');
  }
}
