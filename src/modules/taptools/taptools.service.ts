import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { HttpException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, Repository } from 'typeorm';

import { DexHunterPricingService } from '../dexhunter/dexhunter-pricing.service';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';
import { WayUpPricingService } from '../wayup/wayup-pricing.service';

import { AssetValueDto, BlockfrostAssetResponseDto } from './dto/asset-value.dto';
import { BlockfrostAddressTotalDto } from './dto/blockfrost-address.dto';
import { PaginationMetaDto, PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto, WalletOverviewDto } from './dto/wallet-summary.dto';

import { Asset } from '@/database/asset.entity';
import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { PriceService } from '@/modules/price/price.service';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { TreasuryWalletService } from '@/modules/vaults/treasure/treasure-wallet.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);

  private readonly isMainnet: boolean;
  private cache = new NodeCache({ stdTTL: 600 }); // cache for 10 minutes to reduce API calls for ADA price
  private readonly blockfrost: BlockFrostAPI;
  private readonly axiosTapToolsInstance: AxiosInstance;
  private assetDetailsCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });
  private walletUnitsCache = new NodeCache({ stdTTL: 60 }); // cache for 1 minute for wallet asset units
  private traitPricesCache = new NodeCache({ stdTTL: 600 }); // cache trait prices for 10 minutes

  // Relics of Magma trait-based pricing configuration
  private readonly RELICS_OF_MAGMA_VITA_POLICY = '94ec588251e710b7660dfd7765f08c87742a3012cce802897a3ebd28';
  private readonly RELICS_OF_MAGMA_PORTA_POLICY = '14296258677a869366d6bb01568f31f7b2e690208739b7bcdca444b2';
  // Fallback prices if TapTools API fails
  private readonly RELICS_CHARACTER_PRICES_FALLBACK = {
    Exploratur: 300, // 300 ADA
    Phoenix: 200, // 200 ADA
    Balaena: 140, // 140 ADA
  };
  private readonly RELICS_PORTA_PRICE_FALLBACK = 70; // 70 ADA for all Porta NFTs - fallback
  private readonly testnetPrices = {
    // Policy-level prices (fallback when no asset-specific price exists)
    f61a534fd4484b4b58d5ff18cb77cfc9e74ad084a18c0409321c811a: 0.00526,
    ed8145e0a4b8b54967e8f7700a5ee660196533ded8a55db620cc6a37: 0.00374,
    '755457ffd6fffe7b20b384d002be85b54a0b3820181f19c5f9032c2e': 250.0,
    fd948c7248ecef7654f77a0264a188dccc76bae5b73415fc51824cf3: 19000.0,
    add6529cc60380af5d51566e32925287b5b04328332652ccac8de0a9: 36.0,
    '4e529151fe66164ebcf52f81033eb0ec55cc012cb6c436104b30fa36': 69.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16': 3400.0,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8': 115.93,
    '0d27d4483fc9e684193466d11bc6d90a0ff1ab10a12725462197188a': 188.57,
    '53173a3d7ae0a0015163cc55f9f1c300c7eab74da26ed9af8c052646': 100000.0,
    '91918871f0baf335d32be00af3f0604a324b2e0728d8623c0d6e2601': 250000.0,

    // Asset-specific prices (policyId + assetName) - for testing multiple multipliers
    // Example: Different prices for individual NFTs within the same policy
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303031': 3400.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303032': 3500.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303033': 3600.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303034': 3700.0,
    '0b89a746fd2d859e0b898544487c17d9ac94b187ea4c74fd0bfbab16526f6d616e2330303035': 3800.0,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543031': 115.93,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543032': 120.5,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543033': 125.75,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543034': 130.25,
    '436ca2e51fa2887fa306e8f6aa0c8bda313dd5882202e21ae2972ac8546573744e46543035': 135,
  };

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Snapshot)
    private readonly snapshotRepository: Repository<Snapshot>,
    private readonly assetsService: AssetsService,
    private readonly priceService: PriceService,
    private readonly configService: ConfigService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly wayUpPricingService: WayUpPricingService,
    @Optional() @Inject('TreasuryWalletService') private readonly treasuryWalletService?: TreasuryWalletService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });

    const tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    const tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');

    this.axiosTapToolsInstance = axios.create({
      baseURL: tapToolsApiUrl,
      headers: {
        'x-api-key': tapToolsApiKey,
      },
    });
  }

  private calculateBalances(data: BlockfrostAddressTotalDto): Map<string, number> {
    const balances = new Map<string, number>();

    // Process received amounts
    data.received_sum?.forEach(asset => {
      balances.set(asset.unit, Number(asset.quantity));
    });

    // Subtract sent amounts
    data.sent_sum?.forEach(asset => {
      const currentBalance = balances.get(asset.unit) || 0;
      balances.set(asset.unit, currentBalance - Number(asset.quantity));
    });

    return balances;
  }

  private async fetchAssetDetailsFromApi(assetId: string): Promise<{
    details: BlockfrostAssetResponseDto;
    cached?: boolean;
  } | null> {
    // Check cache first
    const cacheKey = `asset_details_${assetId}`;
    const cached = this.assetDetailsCache.get<BlockfrostAssetResponseDto>(cacheKey);

    if (cached) {
      return { details: cached, cached: true };
    }

    try {
      const assetDetails = await this.blockfrost.assetsById(assetId);

      // Cache successful response
      this.assetDetailsCache.set(cacheKey, assetDetails as BlockfrostAssetResponseDto);

      return { details: assetDetails as BlockfrostAssetResponseDto, cached: false };
    } catch (error) {
      this.logger.debug(`Failed to fetch details for asset ${assetId}: ${error.message}`);
      return null;
    }
  }

  private decodeAssetName(hexName: string): string {
    try {
      if (!hexName) return 'Unknown Asset';

      // Decode hex to buffer
      const buffer = Buffer.from(hexName, 'hex');
      const decoded = buffer.toString('utf8');

      // Validate UTF-8: check for replacement characters
      if (decoded.includes('\uFFFD')) {
        // Contains replacement character - not valid UTF-8
        return hexName;
      }

      // Validate round-trip: re-encode and compare
      const reEncoded = Buffer.from(decoded, 'utf8').toString('hex');
      if (reEncoded.toLowerCase() !== hexName.toLowerCase()) {
        // Round-trip failed - not valid UTF-8
        return hexName;
      }

      // Valid UTF-8 string
      return decoded;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return hexName || 'Unknown Asset';
    }
  }

  /**
   * Extract character trait from NFT metadata for Relics of Magma collections
   * @param metadata The NFT metadata object
   * @returns Character trait value or null if not found
   */
  private extractCharacterTrait(metadata: any): string | null {
    if (!metadata || typeof metadata !== 'object') return null;

    // Check top-level keys first  (WayUp API format: "attributes / Character")
    const characterKeys = ['attributes / Character', 'Character', 'character'];

    for (const key of characterKeys) {
      if (metadata[key]) {
        return metadata[key];
      }
    }

    // Check if attributes is an object (nested structure)
    if (metadata.attributes && typeof metadata.attributes === 'object' && !Array.isArray(metadata.attributes)) {
      // Check nested attributes keys
      const nestedKeys = ['attributes / Character', 'Character', 'character'];
      for (const key of nestedKeys) {
        if (metadata.attributes[key]) {
          return metadata.attributes[key];
        }
      }
    }

    // Check if attributes is an array (CIP-25 standard)
    if (Array.isArray(metadata.attributes)) {
      const characterAttr = metadata.attributes.find(
        (attr: any) => attr.trait_type === 'Character' || attr.name === 'Character'
      );
      if (characterAttr) {
        return characterAttr.value;
      }
    }

    this.logger.debug(`Character trait not found in metadata`);
    return null;
  }

  /**
   * Fetch trait prices from TapTools API for a given collection policy
   * @param policyId The policy ID of the NFT collection
   * @returns Object containing trait prices or null if failed
   */
  private async fetchTraitPricesFromTapTools(policyId: string): Promise<Record<string, Record<string, number>> | null> {
    // Check cache first
    const cacheKey = `trait_prices_${policyId}`;
    const cached = this.traitPricesCache.get<Record<string, Record<string, number>>>(cacheKey);

    if (cached) {
      return cached;
    }

    // Only works on mainnet - TapTools doesn't support testnet
    if (!this.isMainnet) {
      this.logger.debug('Skipping TapTools trait prices fetch for testnet');
      return null;
    }

    try {
      const endpoint = `/nft/collection/traits/price?policy=${policyId}`;
      this.logger.debug(`Fetching trait prices from TapTools: ${endpoint}`);

      const response = await this.axiosTapToolsInstance.get(endpoint, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
        },
      });

      if (response.data && typeof response.data === 'object') {
        // Cache the result
        this.traitPricesCache.set(cacheKey, response.data);
        this.logger.debug(`Successfully fetched and cached trait prices for policy ${policyId}`);
        return response.data;
      }

      this.logger.warn(`Invalid response format from TapTools trait prices API`);
      return null;
    } catch (error) {
      this.logger.warn(`Failed to fetch trait prices from TapTools: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch Relics of Magma Vita character trait from WayUp API
   * WayUp API returns properly decoded attributes including "attributes / Character"
   * @param policyId The policy ID of the NFT
   * @param name The readable asset name (e.g., "Relics of Magma - The Vita #0899")
   * @returns Character trait value or null if not found
   */
  private async fetchRelicsCharacterFromWayUp(policyId: string, name: string): Promise<string | null> {
    // Only works on mainnet - WayUp doesn't support testnet
    if (!this.isMainnet) {
      this.logger.debug('Skipping WayUp character fetch for testnet');
      return null;
    }

    try {
      // Query WayUp API for the specific asset by name
      const response = await this.wayUpPricingService.getCollectionAssets({
        policyId,
        term: name,
        limit: 1,
      });

      if (response.results.length > 0) {
        const asset = response.results[0];
        // WayUp returns decoded attributes with key "attributes / Character"
        if (asset.attributes) {
          const character = this.extractCharacterTrait(asset.attributes);
          if (character) {
            return character;
          }
        }
      }

      this.logger.debug(`Character trait not found in WayUp response for ${name}`);
      return null;
    } catch (error) {
      this.logger.warn(`Failed to fetch character from WayUp: ${error.message}`);
      return null;
    }
  }

  /**
   * Get trait-based price for Relics of Magma NFTs
   * - Porta: Fetches floor price from WayUp API
   * - Vita: Fetches trait-based prices from TapTools API
   * Falls back to hardcoded prices if APIs fail
   * @param policyId The policy ID of the NFT
   * @param name The readable asset name (e.g., "Relics of Magma - The Vita #0899")
   * @returns Price in ADA or null if not a Relics of Magma NFT
   */
  private async getRelicsOfMagmaPrice(policyId: string, name: string): Promise<number | null> {
    // Handle Relics of Magma - The Porta (fetch floor price from WayUp)
    if (policyId === this.RELICS_OF_MAGMA_PORTA_POLICY) {
      try {
        const floorPriceData = await this.wayUpPricingService.getCollectionFloorPrice(policyId);

        if (floorPriceData.hasListings && floorPriceData.floorPriceAda !== null) {
          return floorPriceData.floorPriceAda;
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch Porta floor price from WayUp: ${error.message}`);
      }

      // Fallback to fixed price if WayUp fails or no listings
      this.logger.debug(`Using fallback price for Porta: ${this.RELICS_PORTA_PRICE_FALLBACK} ADA`);
      return this.RELICS_PORTA_PRICE_FALLBACK;
    }

    // Handle Relics of Magma - The Vita (trait-based pricing from TapTools)
    if (policyId === this.RELICS_OF_MAGMA_VITA_POLICY) {
      // Fetch character trait from WayUp API (they have decoded attributes)
      const character = await this.fetchRelicsCharacterFromWayUp(policyId, name);

      if (character) {
        // Try to get dynamic price from TapTools first
        const traitPrices = await this.fetchTraitPricesFromTapTools(policyId);

        if (traitPrices && traitPrices.Character && traitPrices.Character[character]) {
          this.logger.debug(`Using TapTools price for Vita ${character}: ${traitPrices.Character[character]} ADA`);
          return traitPrices.Character[character];
        }

        // Fallback to hardcoded prices if TapTools fails
        if (this.RELICS_CHARACTER_PRICES_FALLBACK[character]) {
          this.logger.debug(
            `Using fallback price for Vita ${character}: ${this.RELICS_CHARACTER_PRICES_FALLBACK[character]} ADA`
          );
          return this.RELICS_CHARACTER_PRICES_FALLBACK[character];
        }
      }

      // If character trait not found or not recognized, log warning and use default
      this.logger.warn(`Character trait not found or not recognized for Vita NFT. Character: ${character}`);
      return this.RELICS_CHARACTER_PRICES_FALLBACK.Balaena; // Default to Balaena fallback price
    }

    return null;
  }

  /**
   * Get the value of an asset in ADA and USD
   * Uses DexHunter for fungible tokens and WayUp for NFT floor prices
   * @param policyId The policy ID of the asset
   * @param assetName The asset name (hex encoded)
   * @param isNFT Whether the asset is an NFT
   * @param name Optional readable asset name for Relics of Magma trait-based pricing
   * @returns Promise with the asset value in ADA and USD
   */
  async getAssetValue(
    policyId: string,
    assetName: string,
    isNFT: boolean,
    name?: string
  ): Promise<{ priceAda: number; priceUsd: number }> {
    try {
      const adaPrice = await this.priceService.getAdaPrice();

      if (!this.isMainnet) {
        // Check for asset-specific price first (policyId + assetName)
        const assetId = `${policyId}${assetName}`;
        if (this.testnetPrices[assetId] !== undefined) {
          const hardcodedPriceAda = this.testnetPrices[assetId];
          return {
            priceAda: hardcodedPriceAda,
            priceUsd: hardcodedPriceAda * adaPrice,
          };
        }

        // Fall back to policy-level price
        if (this.testnetPrices[policyId] !== undefined) {
          const hardcodedPriceAda = this.testnetPrices[policyId];
          return {
            priceAda: hardcodedPriceAda,
            priceUsd: hardcodedPriceAda * adaPrice,
          };
        }
      }

      const cacheKey = `asset_value_${policyId}_${assetName}`;
      const cached = this.cache.get<{ priceAda: number; priceUsd: number }>(cacheKey);

      if (cached) return cached;

      // Skip external API calls for testnet - return fallback prices
      if (!this.isMainnet) {
        const fallbackPrice = 5.0; // Default testnet price
        return {
          priceAda: fallbackPrice,
          priceUsd: fallbackPrice * adaPrice,
        };
      }

      // Route to appropriate API based on asset type
      if (isNFT) {
        // Relics of Magma - The Porta: Use WayUp floor price
        if (policyId === this.RELICS_OF_MAGMA_PORTA_POLICY) {
          try {
            const traitPrice = await this.getRelicsOfMagmaPrice(policyId, name || '');
            if (traitPrice !== null) {
              const result = {
                priceAda: traitPrice,
                priceUsd: traitPrice * adaPrice,
              };
              this.cache.set(cacheKey, result);
              return result;
            }
          } catch (error) {
            this.logger.warn(`Failed to get floor price for Porta NFT, using fallback: ${error.message}`);
          }
          // Fallback if trait price fetch fails
          const result = {
            priceAda: this.RELICS_PORTA_PRICE_FALLBACK,
            priceUsd: this.RELICS_PORTA_PRICE_FALLBACK * adaPrice,
          };
          this.cache.set(cacheKey, result);
          return result;
        }

        // Relics of Magma - The Vita: TapTools trait-based pricing
        if (policyId === this.RELICS_OF_MAGMA_VITA_POLICY) {
          try {
            // Fetch trait-based price from TapTools API using WayUp for character extraction
            // Pass the readable name for WayUp character trait search
            const traitPrice = await this.getRelicsOfMagmaPrice(policyId, name || '');
            if (traitPrice !== null) {
              const result = {
                priceAda: traitPrice,
                priceUsd: traitPrice * adaPrice,
              };
              this.cache.set(cacheKey, result);
              return result;
            }
          } catch (error) {
            // Fallback to Balaena price for Vita on error
            this.logger.warn(`Failed to get trait-based price for Vita NFT, using Balaena fallback: ${error.message}`);
            const fallbackPrice = this.RELICS_CHARACTER_PRICES_FALLBACK.Balaena;
            const result = {
              priceAda: fallbackPrice,
              priceUsd: fallbackPrice * adaPrice,
            };
            this.cache.set(cacheKey, result);
            return result;
          }
        }

        // Default NFT pricing using WayUp floor price
        try {
          const { floorPriceAda } = await this.wayUpPricingService.getCollectionFloorPrice(policyId);
          if (floorPriceAda > 0) {
            this.cache.set(cacheKey, { priceAda: floorPriceAda, priceUsd: floorPriceAda * adaPrice });
            return { priceAda: floorPriceAda, priceUsd: floorPriceAda * adaPrice };
          }
        } catch (error) {
          this.logger.warn(`WayUp floor price failed for NFT ${policyId}: ${error.message}`);
        }
      } else {
        // Use DexHunter for fungible token prices
        const tokenPriceAda = await this.dexHunterPricingService.getTokenPrice(`${policyId}${assetName}`);

        if (tokenPriceAda !== null && tokenPriceAda > 0) {
          const result = {
            priceAda: tokenPriceAda,
            priceUsd: tokenPriceAda * adaPrice,
          };
          this.cache.set(cacheKey, result);
          return result;
        }

        this.logger.warn(`DexHunter price not available for FT ${policyId}`);
      }

      // Return fallback price if no price found
      return { priceAda: 0, priceUsd: 0 };
    } catch (error) {
      this.logger.error(`Failed to get asset value for ${policyId}:`, error.message);
      // Return fallback price on error
      return { priceAda: 0, priceUsd: 0 };
    }
  }

  /**
   * Helper function to process promises with controlled concurrency
   * @param items Array of items to process
   * @param fn Async function to execute for each item
   * @param concurrency Maximum number of concurrent operations
   * @param delayMs Delay in milliseconds between batches
   */
  private async processWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency: number = 5,
    delayMs: number = 100
  ): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(item => fn(item)));
      results.push(...batchResults);

      // Add delay between batches to avoid rate limiting (except for last batch)
      if (i + concurrency < items.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return results;
  }

  /**
   * Update asset prices in database from DexHunter/WayUp APIs
   * Updates dex_price for FTs and floor_price for NFTs
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Uses controlled concurrency to avoid overwhelming external APIs
   * @param vaultIds Optional array of vault IDs to update assets for. If not provided, updates all active vaults
   */
  async updateAssetPrices(vaultIds?: string[]): Promise<void> {
    try {
      // Build query to get unique assets across specified vaults
      let query = this.assetRepository
        .createQueryBuilder('asset')
        .select(['asset.policy_id', 'asset.asset_id', 'asset.type', 'asset.name'])
        .where('asset.status IN (:...statuses)', {
          statuses: [AssetStatus.PENDING, AssetStatus.LOCKED, AssetStatus.EXTRACTED],
        })
        .andWhere('asset.deleted = false')
        .groupBy('asset.policy_id, asset.asset_id, asset.type, asset.name');

      if (vaultIds && vaultIds.length > 0) {
        query = query.andWhere('asset.vault_id IN (:...vaultIds)', { vaultIds });
      }

      const uniqueAssets = await query.getRawMany();
      this.logger.log(`Updating prices for ${uniqueAssets.length} unique assets`);

      let updatedCount = 0;

      // Process with controlled concurrency: 5 concurrent API calls, 100ms delay between batches
      await this.processWithConcurrency(
        uniqueAssets,
        async asset => {
          try {
            const isNFT = asset.asset_type === AssetType.NFT;

            // Skip lovelace
            if (asset.asset_asset_id === 'lovelace') {
              return;
            }

            let priceAda: number | null = null;

            // Use hardcoded testnet prices if available
            if (!this.isMainnet) {
              priceAda = this.testnetPrices[asset.asset_policy_id] || 5.0;
            } else if (isNFT) {
              // Check for Relics of Magma trait-based pricing first
              const relicsPrice = await this.getRelicsOfMagmaPrice(asset.asset_policy_id, asset.asset_name);
              if (relicsPrice !== null) {
                priceAda = relicsPrice;
              } else {
                // Fall back to WayUp collection floor price for other NFTs
                try {
                  const { floorPriceAda } = await this.wayUpPricingService.getCollectionFloorPrice(
                    asset.asset_policy_id
                  );
                  priceAda = floorPriceAda > 0 ? floorPriceAda : null;
                } catch (error) {
                  this.logger.debug(`Failed to get floor price for NFT ${asset.asset_policy_id}: ${error.message}`);
                }
              }
            } else {
              // Get DEX price from DexHunter for FTs
              try {
                const tokenPriceAda = await this.dexHunterPricingService.getTokenPrice(
                  `${asset.asset_policy_id}${asset.asset_asset_id}`
                );
                priceAda = tokenPriceAda !== null && tokenPriceAda > 0 ? tokenPriceAda : null;
              } catch (error) {
                this.logger.debug(`Failed to get DEX price for FT ${asset.asset_policy_id}: ${error.message}`);
              }
            }

            if (priceAda !== null) {
              // Update all assets with this policy_id and asset_id
              await this.assetRepository.update(
                {
                  policy_id: asset.asset_policy_id,
                  asset_id: asset.asset_asset_id,
                  deleted: false,
                },
                {
                  [isNFT ? 'floor_price' : 'dex_price']: priceAda,
                  last_valuation: new Date(),
                }
              );
              updatedCount++;
            }
          } catch (error) {
            this.logger.error(
              `Error updating price for asset ${asset.asset_policy_id}.${asset.asset_asset_id}:`,
              error.message
            );
          }
        },
        5, // Max 5 concurrent API calls
        100 // 100ms delay between batches
      );

      this.logger.log(`Successfully updated prices for ${updatedCount} assets`);
    } catch (error) {
      this.logger.error('Error in updateAssetPrices:', error.message);
      throw error;
    }
  }

  /**
   * Calculate the total value of all assets in a vault
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Uses cached prices from database (dex_price/floor_price)
   * Set updatePrices=true only during phase transitions to fetch fresh prices
   * @param vaultId The ID of the vault
   * @param updatePrices If true, fetches fresh prices from APIs. If false, uses cached prices
   * @returns Promise with the vault assets summary
   */
  async calculateVaultAssetsValue(vaultId: string, updatePrices: boolean = false): Promise<VaultAssetsSummaryDto> {
    // Get the vault to verify it exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['assets', 'owner'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault with ID ${vaultId} not found`);
    }

    // If updatePrices is true, fetch fresh prices first
    if (updatePrices) {
      await this.updateAssetPrices([vaultId]);
    }

    const adaPrice = await this.priceService.getAdaPrice();

    // Group assets by policyId and assetId to handle quantities
    const assetMap = new Map<
      string,
      {
        policyId: string;
        assetId: string;
        quantity: number;
        isNft: boolean;
        cachedPrice?: number;
        metadata?: Record<string, unknown>;
        name?: string;
      }
    >();

    let totalAcquiredAda = 0;

    // Group assets and track acquired ADA in one pass
    for (const asset of vault.assets) {
      if (asset.origin_type === AssetOriginType.ACQUIRED && asset.policy_id === 'lovelace') {
        totalAcquiredAda += Number(asset.quantity);
      }

      // Skip assets that are not in a valid status for valuation
      // Include PENDING, LOCKED, and EXTRACTED (in treasury wallet)
      if (
        asset.status !== AssetStatus.PENDING &&
        asset.status !== AssetStatus.LOCKED &&
        asset.status !== AssetStatus.EXTRACTED
      ) {
        continue;
      }

      const key = `${asset.policy_id}_${asset.asset_id}`;
      const existingAsset = assetMap.get(key);

      if (existingAsset) {
        existingAsset.quantity += asset.type === AssetType.NFT ? 1 : Number(asset.quantity);
      } else {
        // Use cached price from database (dex_price for FTs, floor_price for NFTs)
        const cachedPrice = asset.type === AssetType.NFT ? asset.floor_price : asset.dex_price;

        assetMap.set(key, {
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
          isNft: asset.type === AssetType.NFT,
          cachedPrice: cachedPrice ? Number(cachedPrice) : undefined,
          metadata: asset.metadata || {},
          name: asset.name,
        });
      }
    }

    // Calculate values for grouped assets
    const assetsWithValues = [];
    let totalValueAda = 0;
    let totalValueUsd = 0;

    for (const asset of assetMap.values()) {
      try {
        // Skip administrative/fee tokens
        if (asset.metadata?.purpose === 'vault_creation_fee') {
          assetsWithValues.push({
            ...asset,
            assetName: asset.assetId,
            valueAda: 0,
            valueUsd: 0,
          });
          continue;
        }

        if (asset.assetId === 'lovelace') {
          const totalAdaValue = asset.quantity * 1e-6;
          assetsWithValues.push({
            ...asset,
            assetName: 'ADA',
            valueAda: totalAdaValue,
            valueUsd: totalAdaValue * adaPrice,
          });
          totalValueAda += totalAdaValue;
          totalValueUsd += totalAdaValue * adaPrice;
          continue;
        }

        // Use cached price if available and not updating prices
        let valueAda = 0;
        let valueUsd = 0;

        if (asset.cachedPrice !== undefined && asset.cachedPrice > 0) {
          // Use cached price from database
          valueAda = asset.cachedPrice;
          valueUsd = valueAda * adaPrice;
        } else {
          const assetValue = await this.getAssetValue(asset.policyId, asset.assetId, asset.isNft, asset.name);
          valueAda = assetValue?.priceAda || 0;
          valueUsd = assetValue?.priceUsd || 0;
        }

        const totalAssetValueAda = valueAda * asset.quantity;
        const totalAssetValueUsd = valueUsd * asset.quantity;

        assetsWithValues.push({
          ...asset,
          assetName: asset.assetId,
          valueAda: totalAssetValueAda,
          valueUsd: totalAssetValueUsd,
        });

        totalValueAda += totalAssetValueAda;
        totalValueUsd += totalAssetValueUsd;
      } catch (error) {
        console.warn(`Could not value asset ${asset.policyId}.${asset.assetId}:`, error.message);
      }
    }

    if (updatePrices && assetsWithValues.length > 0) {
      await this.assetsService.updateBulkAssetValuations(
        assetsWithValues.map(asset => ({
          policyId: asset.policyId,
          assetId: asset.assetId,
          valueAda: asset.valueAda / asset.quantity, // Get per-unit price
          isNft: asset.isNft,
        }))
      );
      await this.userRepository.update({ id: vault.owner.id }, { tvl: totalValueAda });
    }

    // Add treasury wallet balance to protocol TVL (if exists)
    let treasuryAdaValue = 0;

    try {
      if (this.treasuryWalletService) {
        const treasuryBalance = await this.treasuryWalletService.getTreasuryWalletBalance(vault.id);

        if (treasuryBalance) {
          // Add ADA from treasury
          treasuryAdaValue = treasuryBalance.lovelace * 1e-6;
          totalValueAda += treasuryAdaValue;
          totalValueUsd += treasuryAdaValue * adaPrice;

          // Value treasury assets (NFTs and FTs)
          for (const asset of treasuryBalance.assets) {
            try {
              // Determine if asset is NFT by quantity (1 = NFT, >1 = FT)
              const isNft = asset.quantity === '1';
              const quantity = Number(asset.quantity);

              const assetValue = await this.getAssetValue(asset.policyId, asset.assetName, isNft);
              const valueAda = assetValue?.priceAda || 0;

              totalValueAda += valueAda * quantity;
              totalValueUsd += valueAda * adaPrice * quantity;
            } catch (error) {
              this.logger.debug(`Could not value treasury asset ${asset.unit}: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      // Treasury wallet doesn't exist or error fetching - continue without it
      this.logger.debug(`No treasury wallet for vault ${vault.id}: ${error.message}`);
    }

    // Group assets by policy ID for progress bars
    const assetsByPolicyMap = new Map<string, { policyId: string; quantity: number }>();

    for (const asset of assetsWithValues) {
      // Skip lovelace and fee tokens from policy grouping
      if (asset.assetId === 'lovelace' || asset.assetId === 'ADA' || asset.metadata?.purpose === 'vault_creation_fee') {
        continue;
      }

      const existing = assetsByPolicyMap.get(asset.policyId);
      if (existing) {
        existing.quantity += asset.quantity;
      } else {
        assetsByPolicyMap.set(asset.policyId, {
          policyId: asset.policyId,
          quantity: asset.quantity,
        });
      }
    }

    // Create and return the summary
    return {
      totalValueAda: +totalValueAda.toFixed(6),
      totalValueUsd: +totalValueUsd.toFixed(2),
      totalAssets: assetsWithValues.length,
      nfts: assetsWithValues.filter(a => a.isNft).length,
      tokens: assetsWithValues.filter(a => !a.isNft).length,
      lastUpdated: new Date().toISOString(),
      totalAcquiredAda,
      totalAcquiredUsd: totalAcquiredAda * adaPrice,
      adaPrice,
      assetsByPolicy: Array.from(assetsByPolicyMap.values()),
    };
  }

  /**
   * Update cached vault totals for multiple vaults
   * Includes assets with PENDING, LOCKED, EXTRACTED (in treasury), and DISTRIBUTED status
   * Also calculates user TVL and gains based on:
   * - For locked vaults: VT token holdings (proportional ownership)
   * - For active vaults: Contributed asset values
   * For locked vaults, also calculates FDV/TVL ratio
   * @param vaultIds Array of vault IDs to update
   */
  async updateMultipleVaultTotals(vaultIds: string[]): Promise<void> {
    if (vaultIds.length === 0) return;

    const batchResults = await this.batchCalculateVaultAssetsValue(vaultIds);
    const adaPrice = await this.priceService.getAdaPrice();

    const vaults: Pick<
      Vault,
      'id' | 'initial_total_value_ada' | 'vault_status' | 'ft_token_supply' | 'fdv' | 'owner'
    >[] = await this.vaultRepository.find({
      where: { id: In(vaultIds) },
      relations: ['owner'],
      select: ['id', 'initial_total_value_ada', 'vault_status', 'ft_token_supply', 'fdv', 'owner'],
    });

    const vaultMap = new Map(vaults.map(v => [v.id, v]));

    // Update vault totals
    const updatePromises = Array.from(batchResults.entries()).map(([vaultId, summary]) => {
      const vault = vaultMap.get(vaultId);
      let gainsAda = 0;
      let gainsUsd = 0;

      if (vault?.initial_total_value_ada && vault.initial_total_value_ada > 0) {
        gainsAda = summary.totalValueAda - vault.initial_total_value_ada;
        gainsUsd = gainsAda * adaPrice;
      }

      const updateData: any = {
        total_assets_cost_ada: summary.totalValueAda,
        total_assets_cost_usd: summary.totalValueUsd,
        gains_ada: gainsAda,
        gains_usd: gainsUsd,
        last_valuation_update: new Date(),
      };

      // Update FDV/TVL ratio for locked vaults
      if (vault?.vault_status === VaultStatus.locked && vault.fdv && summary.totalValueAda > 0.0001) {
        updateData.fdv_tvl = Number((vault.fdv / summary.totalValueAda).toFixed(2));
      }

      return this.vaultRepository.update({ id: vaultId }, updateData);
    });

    await Promise.all(updatePromises);

    // Batch fetch all data needed to identify affected users
    const activeVaultIds = Array.from(batchResults.keys()).filter(vaultId => {
      const vault = vaultMap.get(vaultId);
      return vault && (vault.vault_status === VaultStatus.contribution || vault.vault_status === VaultStatus.acquire);
    });

    const lockedVaultIds = Array.from(batchResults.keys()).filter(vaultId => {
      const vault = vaultMap.get(vaultId);
      return vault && vault.vault_status === VaultStatus.locked;
    });

    // Batch query: Get all contributors for active vaults
    const contributorsRaw =
      activeVaultIds.length > 0
        ? await this.assetRepository
            .createQueryBuilder('asset')
            .select(['asset.vault_id as vault_id', 'asset.added_by as added_by'])
            .where('asset.vault_id IN (:...vaultIds)', { vaultIds: activeVaultIds })
            .andWhere('asset.status IN (:...statuses)', {
              statuses: [AssetStatus.LOCKED, AssetStatus.DISTRIBUTED, AssetStatus.EXTRACTED],
            })
            .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
            .andWhere('asset.added_by IS NOT NULL')
            .distinct(true)
            .getRawMany()
        : [];

    // Batch query: Get all snapshots for locked vaults (latest per vault)
    const snapshots =
      lockedVaultIds.length > 0
        ? await this.snapshotRepository
            .createQueryBuilder('snapshot')
            .distinctOn(['snapshot.vault_id'])
            .where('snapshot.vault_id IN (:...vaultIds)', { vaultIds: lockedVaultIds })
            .orderBy('snapshot.vault_id', 'ASC')
            .addOrderBy('snapshot.created_at', 'DESC')
            .getMany()
        : [];

    // Collect all unique addresses from snapshots
    const snapshotAddresses = new Set<string>();
    snapshots.forEach(snapshot => {
      if (snapshot.addressBalances) {
        Object.keys(snapshot.addressBalances).forEach(addr => snapshotAddresses.add(addr));
      }
    });

    // Batch query: Get all users by addresses
    const usersByAddress =
      snapshotAddresses.size > 0
        ? await this.userRepository.find({
            where: { address: In([...snapshotAddresses]) },
            select: ['id', 'address'],
          })
        : [];

    const addressToUserIdMap = new Map(usersByAddress.map(u => [u.address, u.id]));

    // Identify affected users
    const affectedUserIds = new Set<string>();

    // Add vault owners
    vaultMap.forEach(vault => {
      if (vault.owner?.id) affectedUserIds.add(vault.owner.id);
    });

    // Add contributors
    contributorsRaw.forEach(c => {
      if (c.added_by) affectedUserIds.add(c.added_by);
    });

    // Add VT token holders
    snapshots.forEach(snapshot => {
      if (snapshot.addressBalances) {
        Object.keys(snapshot.addressBalances).forEach(address => {
          const userId = addressToUserIdMap.get(address);
          if (userId) affectedUserIds.add(userId);
        });
      }
    });

    // Recalculate complete TVL and gains for all affected users from ALL their vaults
    if (affectedUserIds.size > 0) {
      this.logger.log(`Recalculating complete TVL and gains for ${affectedUserIds.size} affected users`);

      // Batch query: Get all relevant vaults
      const allRelevantVaults = await this.vaultRepository.find({
        where: {
          deleted: false,
          vault_status: In([VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
        },
        relations: ['owner'],
        select: ['id', 'vault_status', 'ft_token_supply', 'ft_token_decimals', 'initial_total_value_ada', 'owner'],
      });

      // Batch query: Get all vault values at once
      const allVaultIds = allRelevantVaults.map(v => v.id);
      const allVaultValues = await this.batchCalculateVaultAssetsValue(allVaultIds);

      // Batch query: Get all snapshots for locked vaults
      const allLockedVaultIds = allRelevantVaults.filter(v => v.vault_status === VaultStatus.locked).map(v => v.id);
      const allSnapshots =
        allLockedVaultIds.length > 0
          ? await this.snapshotRepository
              .createQueryBuilder('snapshot')
              .distinctOn(['snapshot.vault_id'])
              .where('snapshot.vault_id IN (:...vaultIds)', { vaultIds: allLockedVaultIds })
              .orderBy('snapshot.vault_id', 'ASC')
              .addOrderBy('snapshot.created_at', 'DESC')
              .getMany()
          : [];

      const snapshotByVaultId = new Map(allSnapshots.map(s => [s.vaultId, s]));

      // Batch query: Get all users with their addresses
      const allUsers = await this.userRepository.find({
        where: { id: In([...affectedUserIds]) },
        select: ['id', 'address'],
      });
      const userMap = new Map(allUsers.map(u => [u.id, u]));

      // Batch query: Get all contributed assets for all users and active vaults
      const allActiveVaultIds = allRelevantVaults
        .filter(v => v.vault_status === VaultStatus.contribution || v.vault_status === VaultStatus.acquire)
        .map(v => v.id);

      const allContributedAssets =
        allActiveVaultIds.length > 0
          ? await this.assetRepository.find({
              where: {
                vault: { id: In(allActiveVaultIds) },
                added_by: { id: In([...affectedUserIds]) },
                status: In([AssetStatus.LOCKED, AssetStatus.DISTRIBUTED, AssetStatus.EXTRACTED]),
                origin_type: AssetOriginType.CONTRIBUTED,
              },
              select: ['vault', 'added_by', 'quantity', 'dex_price', 'floor_price', 'type'],
              relations: ['vault', 'added_by'],
            })
          : [];

      // Group contributed assets by user and vault
      const assetsByUserAndVault = new Map<string, Map<string, typeof allContributedAssets>>();
      allContributedAssets.forEach(asset => {
        const userId = asset.added_by.id;
        const vaultId = asset.vault.id;

        if (!assetsByUserAndVault.has(userId)) {
          assetsByUserAndVault.set(userId, new Map());
        }
        if (!assetsByUserAndVault.get(userId).has(vaultId)) {
          assetsByUserAndVault.get(userId).set(vaultId, []);
        }
        assetsByUserAndVault.get(userId).get(vaultId).push(asset);
      });

      // Calculate TVL and gains for each user
      const userUpdates: Array<{ id: string; tvl: number; gains: number }> = [];

      for (const userId of affectedUserIds) {
        const user = userMap.get(userId);
        if (!user) continue;

        const userTvl = { tvl: 0, gains: 0 };

        // Calculate from all vaults
        for (const vault of allRelevantVaults) {
          const summary = allVaultValues.get(vault.id);
          if (!summary) continue;

          if (vault.vault_status === VaultStatus.locked) {
            // Get user's share from VT token holdings
            const snapshot = snapshotByVaultId.get(vault.id);

            if (snapshot?.addressBalances && vault.ft_token_supply) {
              const vtBalance = Number(snapshot.addressBalances[user.address] || 0);
              if (vtBalance > 0) {
                // VT tokens in snapshot are in smallest units (e.g., 1000000 for 1 token with 6 decimals)
                // ft_token_supply might be in human-readable units (e.g., 1 instead of 1000000)
                // We need to normalize both to the same unit using ft_token_decimals
                const decimals = vault.ft_token_decimals || 6; // Default to 6 if not set
                const ftSupplySmallestUnits = Number(vault.ft_token_supply) * Math.pow(10, decimals);

                // Guard against invalid or zero supply to avoid division by zero
                if (!Number.isFinite(ftSupplySmallestUnits) || ftSupplySmallestUnits <= 0) {
                  continue;
                }
                // Now both are in smallest units
                const userShare = vtBalance / ftSupplySmallestUnits;

                // Validate share is reasonable (0-100%)
                if (userShare > 1 || userShare < 0) {
                  continue;
                }

                const userVaultTvl = userShare * summary.totalValueAda;
                userTvl.tvl += userVaultTvl;

                // Calculate proportional gains (including negative)
                if (vault.initial_total_value_ada !== null && vault.initial_total_value_ada !== undefined) {
                  const initialUserValue = userShare * vault.initial_total_value_ada;
                  const vaultGains = userVaultTvl - initialUserValue;
                  userTvl.gains += vaultGains;
                }
              }
            }
          } else if (vault.vault_status === VaultStatus.contribution || vault.vault_status === VaultStatus.acquire) {
            // Get contributed asset values from pre-loaded data
            const userVaultAssets = assetsByUserAndVault.get(userId)?.get(vault.id);
            if (userVaultAssets) {
              for (const asset of userVaultAssets) {
                const price = asset.type === AssetType.NFT ? asset.floor_price || 0 : asset.dex_price || 0;
                userTvl.tvl += Number(asset.quantity) * price;
              }
            }
          }
        }

        userUpdates.push({ id: userId, tvl: userTvl.tvl, gains: userTvl.gains });
      }

      // Batch update all users
      await Promise.all(
        userUpdates.map(update =>
          this.userRepository.update({ id: update.id }, { tvl: update.tvl, gains: update.gains })
        )
      );
    }
  }

  /**
   * Batch calculate vault assets values for multiple vaults
   * Includes assets with PENDING, LOCKED, and EXTRACTED (in treasury wallet) status
   * Much more efficient than calling calculateVaultAssetsValue() for each vault
   * Uses cached prices from database (dex_price/floor_price)
   * @param vaultIds Array of vault IDs to calculate values for
   * @returns Map of vaultId -> asset summary
   */
  async batchCalculateVaultAssetsValue(
    vaultIds: string[]
  ): Promise<Map<string, { totalValueAda: number; totalValueUsd: number; totalAcquiredAda: number }>> {
    const resultMap = new Map<string, { totalValueAda: number; totalValueUsd: number; totalAcquiredAda: number }>();

    if (vaultIds.length === 0) {
      return resultMap;
    }

    try {
      // Fetch all vaults at once
      const vaults = await this.vaultRepository.find({
        where: { id: In(vaultIds) },
        relations: ['assets'],
      });

      const adaPrice = await this.priceService.getAdaPrice();

      // Process each vault
      for (const vault of vaults) {
        let totalValueAda = 0;
        let totalValueUsd = 0;
        let totalAcquiredAda = 0;

        // Group assets by policyId and assetId with cached prices
        const assetMap = new Map<
          string,
          {
            policyId: string;
            assetId: string;
            quantity: number;
            isNft: boolean;
            cachedPrice?: number;
            name?: string;
          }
        >();

        for (const asset of vault.assets) {
          // Skip invalid statuses
          // Include PENDING, LOCKED, and EXTRACTED (in treasury wallet)
          if (
            asset.status !== AssetStatus.PENDING &&
            asset.status !== AssetStatus.LOCKED &&
            asset.status !== AssetStatus.EXTRACTED
          ) {
            continue;
          }

          // Track acquired ADA
          if (asset.origin_type === AssetOriginType.ACQUIRED && asset.policy_id === 'lovelace') {
            totalAcquiredAda += Number(asset.quantity);
          }

          // Only process contributed assets for TVL
          if (asset.origin_type !== AssetOriginType.CONTRIBUTED) {
            continue;
          }

          const key = `${asset.policy_id}_${asset.asset_id}`;
          const existingAsset = assetMap.get(key);

          if (existingAsset) {
            if (asset.type === AssetType.NFT) {
              existingAsset.quantity += 1;
            } else {
              existingAsset.quantity += Number(asset.quantity);
            }
          } else {
            // Use cached price from database
            const cachedPrice = asset.type === AssetType.NFT ? asset.floor_price : asset.dex_price;

            assetMap.set(key, {
              policyId: asset.policy_id,
              assetId: asset.asset_id,
              quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
              isNft: asset.type === AssetType.NFT,
              cachedPrice: cachedPrice ? Number(cachedPrice) : undefined,
              name: asset.name,
            });
          }
        }

        // Calculate values for all assets using cached prices
        const assets = Array.from(assetMap.values());

        for (const asset of assets) {
          try {
            // Handle ADA specially
            if (asset.assetId === 'lovelace') {
              const totalAdaValue = asset.quantity * 1e-6;
              totalValueAda += totalAdaValue;
              totalValueUsd += totalAdaValue * adaPrice;
              continue;
            }

            // Use cached price if available
            let valueAda = 0;

            if (asset.cachedPrice !== undefined && asset.cachedPrice > 0) {
              valueAda = asset.cachedPrice;
            } else {
              const assetValue = await this.getAssetValue(asset.policyId, asset.assetId, asset.isNft, asset.name);
              valueAda = assetValue?.priceAda || 0;
            }

            totalValueAda += valueAda * asset.quantity;
            totalValueUsd += valueAda * adaPrice * asset.quantity;
          } catch (error) {
            // Skip assets that can't be valued
            this.logger.debug(`Could not value asset ${asset.policyId}.${asset.assetId}: ${error.message}`);
          }
        }

        // Add treasury wallet balance to protocol TVL (if exists)
        let treasuryAdaValue = 0;

        try {
          if (this.treasuryWalletService) {
            const treasuryBalance = await this.treasuryWalletService.getTreasuryWalletBalance(vault.id);

            if (treasuryBalance) {
              // Add ADA from treasury
              treasuryAdaValue = treasuryBalance.lovelace * 1e-6;
              totalValueAda += treasuryAdaValue;
              totalValueUsd += treasuryAdaValue * adaPrice;

              // Value treasury assets (NFTs and FTs)
              for (const asset of treasuryBalance.assets) {
                try {
                  // THIS IS WRONG
                  // Determine if asset is NFT by quantity (1 = NFT, >1 = FT)
                  const isNft = asset.quantity === '1';
                  const quantity = Number(asset.quantity);

                  const assetValue = await this.getAssetValue(asset.policyId, asset.assetName, isNft);
                  const valueAda = assetValue?.priceAda || 0;

                  totalValueAda += valueAda * quantity;
                  totalValueUsd += valueAda * adaPrice * quantity;
                } catch (error) {
                  this.logger.debug(`Could not value treasury asset ${asset.unit}: ${error.message}`);
                }
              }
            }
          }
        } catch (error) {
          // Treasury wallet doesn't exist or error fetching - continue without it
          this.logger.debug(`No treasury wallet for vault ${vault.id}: ${error.message}`);
        }

        resultMap.set(vault.id, {
          totalValueAda: +totalValueAda.toFixed(6),
          totalValueUsd: +totalValueUsd.toFixed(2),
          totalAcquiredAda,
        });
      }

      return resultMap;
    } catch (error) {
      this.logger.error('Error in batch calculate vault assets:', error.message);
      // Return empty map on error
      return resultMap;
    }
  }

  async getWalletSummaryPaginated(paginationQuery: PaginationQueryDto): Promise<PaginatedWalletSummaryDto> {
    const { address: walletAddress, page, limit, filter, whitelistedPolicies, search } = paginationQuery;

    try {
      const adaPriceUsd = await this.priceService.getAdaPrice();

      // Get overview (cached)
      const overview = await this.getWalletOverview(walletAddress, adaPriceUsd);

      // Get paginated assets
      const { assets, pagination } = await this.getPaginatedAssets(
        walletAddress,
        page,
        limit,
        filter,
        whitelistedPolicies,
        search
      );

      const result = {
        overview,
        assets,
        pagination,
      };

      return plainToInstance(PaginatedWalletSummaryDto, result, {
        excludeExtraneousValues: true,
      });
    } catch (err) {
      this.logger.error('Error fetching paginated wallet summary:', err.message);

      if (axios.isAxiosError(err)) {
        if (err.response?.status === 404) {
          throw new HttpException('Wallet address not found', 404);
        }
        throw new HttpException(
          err.response?.data?.message || 'Failed to fetch wallet assets',
          err.response?.status || 500
        );
      }
      throw new HttpException('Failed to fetch or process wallet assets', 500);
    }
  }

  private async getWalletOverview(walletAddress: string, adaPriceUsd: number): Promise<WalletOverviewDto> {
    const overviewCacheKey = `wallet_overview_${walletAddress}`;
    const cached = this.cache.get<WalletOverviewDto>(overviewCacheKey);

    if (cached) {
      return cached;
    }

    try {
      // Validate address and check if it exists
      try {
        await this.blockfrost.addresses(walletAddress);
      } catch (error) {
        // If address has never received transactions, Blockfrost returns 404
        if (error.status_code === 404 || error.message?.includes('not been found')) {
          // Return empty wallet overview
          const emptyOverviewData = {
            wallet: walletAddress,
            totalValueAda: 0,
            totalValueUsd: 0,
            lastUpdated: new Date().toISOString(),
            summary: {
              totalAssets: 0,
              nfts: 0,
              tokens: 0,
              ada: 0,
            },
          };
          const emptyOverview = plainToInstance(WalletOverviewDto, emptyOverviewData, {
            excludeExtraneousValues: true,
          });
          this.cache.set(overviewCacheKey, emptyOverview, 300);
          return emptyOverview;
        }
        throw error; // Re-throw unexpected errors
      }

      // Get totals
      const addressTotal = await this.blockfrost.addressesTotal(walletAddress);

      const balances = this.calculateBalances(addressTotal);
      const totalAda = (balances.get('lovelace') || 0) / 1000000;
      const nonAdaAssets = Array.from(balances.entries()).filter(
        ([unit, balance]) => unit !== 'lovelace' && balance > 0
      );

      const overviewData = {
        wallet: walletAddress,
        totalValueAda: +totalAda.toFixed(4),
        totalValueUsd: +(totalAda * adaPriceUsd).toFixed(4),
        lastUpdated: new Date().toISOString(),
        summary: {
          totalAssets: nonAdaAssets.length,
          nfts: nonAdaAssets.filter(([, quantity]) => quantity === 1).length,
          tokens: nonAdaAssets.filter(([, quantity]) => quantity > 1).length,
          ada: totalAda,
        },
      };

      // Transform to DTO using plainToInstance
      const overview = plainToInstance(WalletOverviewDto, overviewData, {
        excludeExtraneousValues: true,
      });

      // Cache for 5 minutes
      this.cache.set(overviewCacheKey, overview, 300);
      return overview;
    } catch (err) {
      this.logger.error('Error creating wallet overview:', err.message);
      if (err.response?.status_code === 404) {
        throw new HttpException('Wallet address not found', 404);
      }
      throw new HttpException('Failed to fetch wallet overview', 500);
    }
  }

  private async getPaginatedAssets(
    walletAddress: string,
    page: number,
    limit: number,
    filter: 'all' | 'nfts' | 'tokens',
    whitelistedPolicies: string[],
    search?: string
  ): Promise<{ assets: AssetValueDto[]; pagination: PaginationMetaDto }> {
    try {
      // Get all asset units (cached)
      const filteredAssets = await this.getFilteredUnits(walletAddress, whitelistedPolicies);

      // Process all assets to apply NFT/Token and search filters
      const allProcessedAssets = await this.processAssetsPage(filteredAssets, filter, search);

      // Calculate pagination AFTER filtering
      const total = allProcessedAssets.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      const pageAssets = allProcessedAssets.slice(offset, offset + limit);

      const paginationData = {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      };

      const pagination = plainToInstance(PaginationMetaDto, paginationData, {
        excludeExtraneousValues: true,
      });

      return { assets: pageAssets, pagination };
    } catch (err) {
      this.logger.error('Error getting paginated assets:', err.message);
      throw new HttpException('Failed to fetch paginated assets', 500);
    }
  }

  private async getFilteredUnits(
    walletAddress: string,
    whitelistedPolicies: string[]
  ): Promise<{ unit: string; quantity: number }[]> {
    const cacheKey = `wallet_assets_${walletAddress}`;
    const cached = this.walletUnitsCache.get<Array<{ unit: string; quantity: number }>>(cacheKey);

    let assetUnits: Array<{ unit: string; quantity: number }>;

    if (cached) {
      assetUnits = cached;
    } else {
      try {
        const addressTotal = await this.blockfrost.addressesTotal(walletAddress);
        const balances = this.calculateBalances(addressTotal);
        assetUnits = Array.from(balances.entries())
          .filter(([unit, balance]) => unit !== 'lovelace' && balance > 0)
          .map(([unit, quantity]) => ({ unit, quantity }));

        // Cache for 2 minutes
        this.walletUnitsCache.set(cacheKey, assetUnits, 60);
      } catch (err) {
        this.logger.error('Error fetching asset units:', err.message);
        throw new HttpException('Failed to fetch asset units', 500);
      }
    }

    return whitelistedPolicies.length
      ? assetUnits.filter(asset => whitelistedPolicies.includes(asset.unit.substring(0, 56)))
      : assetUnits;
  }

  private async processAssetsPage(
    pageAssets: Array<{ unit: string; quantity: number }>,
    filter: 'all' | 'nfts' | 'tokens',
    search?: string
  ): Promise<AssetValueDto[]> {
    const processedAssets: AssetValueDto[] = [];

    // Process assets directly without batching - pagination already limits the number
    for (const asset of pageAssets) {
      const assetDetailsResult = await this.fetchAssetDetailsFromApi(asset.unit);

      if (!assetDetailsResult) {
        throw new HttpException(`Failed to fetch asset details for ${asset.unit}`, 500);
      }

      const details = assetDetailsResult.details;
      const metadata = details.onchain_metadata || details.metadata || {};
      const assetName = this.decodeAssetName(details.asset_name || asset.unit.substring(56));
      const isNFT = this.isNFT(details);

      if (filter === 'nfts' && !isNFT) {
        continue;
      }

      if (filter === 'tokens' && isNFT) {
        continue;
      }

      // Apply search filter
      if (search && search.trim()) {
        const searchLower = search.toLowerCase().trim();
        const displayName = String((metadata as Record<string, unknown>)?.name || assetName).toLowerCase();
        const ticker = String(details.metadata?.ticker || '').toLowerCase();
        const policyId = details.policy_id.toLowerCase();
        const unit = asset.unit.toLowerCase();

        const matchesSearch =
          assetName.toLowerCase().includes(searchLower) ||
          displayName.includes(searchLower) ||
          ticker.includes(searchLower) ||
          policyId.includes(searchLower) ||
          unit.includes(searchLower);

        if (!matchesSearch) {
          continue;
        }
      }

      // Get readable name from metadata for WayUp API (e.g., "Relics of Magma - The Vita #0899")
      const readableName = String((metadata as Record<string, unknown>)?.name || assetName);

      const { priceAda, priceUsd } = await this.getAssetValue(
        assetDetailsResult?.details.policy_id || asset.unit.substring(0, 56),
        assetDetailsResult?.details.asset_name || asset.unit.substring(56),
        isNFT,
        readableName
      );

      const assetData: AssetValueDto = {
        tokenId: asset.unit,
        name: assetName,
        displayName: String((metadata as Record<string, unknown>)?.name || assetName),
        ticker: String(details.metadata?.ticker || ''),
        quantity: asset.quantity,
        isNft: isNFT,
        isFungibleToken: !isNFT,
        priceAda,
        priceUsd,
        valueAda: priceAda * asset.quantity,
        valueUsd: priceUsd * asset.quantity,
        metadata: {
          image: String((metadata as Record<string, unknown>)?.image || ''),
          policyId: details.policy_id,
          decimals: details.metadata?.decimals || 0,
          description: String((metadata as Record<string, unknown>)?.description || ''),
          assetName: details.asset_name,
          fallback: false,
        },
      };

      const assetDto = plainToInstance(AssetValueDto, assetData, {
        excludeExtraneousValues: true,
      });

      processedAssets.push(assetDto);
    }

    return processedAssets;
  }

  /**
   * Determine if an asset is an NFT or Fungible Token
   * Uses multiple heuristics for accurate detection
   * @param assetDetails Asset details from Blockfrost
   * @returns true if NFT, false if FT
   */
  private isNFT(assetDetails: BlockfrostAssetResponseDto): boolean {
    // 1. Check for decimals first (strongest FT indicator)
    if (assetDetails.metadata?.decimals !== undefined) {
      return false;
    }

    // 2. Check total quantity (most reliable for NFTs)
    if (assetDetails.quantity === '1') {
      return true;
    }

    // 3. If quantity > 1, it's a fungible token
    const qty = parseInt(assetDetails.quantity);
    if (qty > 1) {
      return false;
    }

    // 4. Check for NFT-specific metadata (CIP-25)
    const metadata = assetDetails.onchain_metadata;
    if (metadata) {
      // Check for NFT-specific fields (attributes, mediaType, files)
      if (metadata.attributes || metadata.mediaType || metadata.files) {
        return true;
      }
    }

    // 5. Fallback: assume NFT if quantity is 1
    return qty === 1;
  }

  public invalidateWalletCache(walletAddress: string): void {
    if (!walletAddress) return;

    const assetsCacheKey = `wallet_assets_${walletAddress}`;

    const overviewCacheKey = `wallet_overview_${walletAddress}`;

    const deletedAssets = this.walletUnitsCache.del(assetsCacheKey);
    const deletedOverview = this.cache.del(overviewCacheKey);

    this.logger.log(
      `Cache invalidated for wallet ${walletAddress}. ` +
        `Assets deleted: ${deletedAssets > 0}, Overview deleted: ${deletedOverview > 0}`
    );
  }
}
