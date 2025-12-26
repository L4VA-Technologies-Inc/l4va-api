import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Injectable, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { Repository, In } from 'typeorm';

import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';

import { AssetValueDto, BlockfrostAssetResponseDto } from './dto/asset-value.dto';
import { BlockfrostAddressTotalDto } from './dto/blockfrost-address.dto';
import { PaginationQueryDto, PaginationMetaDto } from './dto/pagination.dto';
import { WalletOverviewDto, PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';

import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AlertsService } from '@/modules/alerts/alerts.service';
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);
  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private readonly taptoolsApiKey: string;
  private readonly isMainnet: boolean;
  private cache = new NodeCache({ stdTTL: 600 }); // cache for 10 minutes to reduce API calls for ADA price
  private readonly blockfrost: BlockFrostAPI;
  private assetDetailsCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });
  private readonly testnetPrices = {
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
  };
  private readonly mainnetPrices = {
    // NFT collections - fallback price 10 ADA
    '5a2cdc6e3aa9612fe4676672f443e7efd39c309d45e7919a4bf27750': 10.0, // BossPlanetDistrict
    '6ecee816357c3d8210b77c5504b2aa2ba23f94194bc6c759cdf7af3f': 10.0, // DogsOnTheChain
    f456dbdd3629be1e138699419ed4f9fe0bcd70cc473b149d658f0f10: 10.0, // Cardacity
  };

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly assetsService: AssetsService,
    private readonly configService: ConfigService,
    private readonly alertsService: AlertsService
  ) {
    this.taptoolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    this.isMainnet = this.configService.get<string>('NETWORK') === 'mainnet';

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async getAdaPrice(): Promise<number> {
    const cacheKey = 'ada_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);

    if (cachedPrice !== undefined) {
      return cachedPrice;
    }

    const fallbackPrice = 0.64;

    try {
      const now = Date.now();
      const lastCallKey = 'last_price_api_call';
      const lastCall = this.cache.get<number>(lastCallKey) || 0;

      if (now - lastCall < 10000) {
        const lastKnownGoodPrice = this.cache.get<number>('last_known_good_ada_price');
        return lastKnownGoodPrice || fallbackPrice;
      }

      this.cache.set(lastCallKey, now);

      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'cardano',
          vs_currencies: 'usd',
        },
        timeout: 3000, // Short timeout to fail fast
      });

      if (!response.data?.cardano?.usd) {
        throw new Error('Invalid price data from API');
      }

      const adaPrice = Number(response.data.cardano.usd);

      // Cache price for longer (15 minutes)
      this.cache.set(cacheKey, adaPrice, 900);
      this.cache.set('last_known_good_ada_price', adaPrice, 86400);

      return adaPrice;
    } catch (err) {
      this.logger.warn(`Error fetching ADA price: ${err.message}`);

      try {
        const altResponse = await axios.get('https://min-api.cryptocompare.com/data/price', {
          params: {
            fsym: 'ADA',
            tsyms: 'USD',
          },
          timeout: 3000,
        });

        if (altResponse.data && altResponse.data.USD) {
          const altPrice = Number(altResponse.data.USD);
          this.cache.set(cacheKey, altPrice, 900);
          this.cache.set('last_known_good_ada_price', altPrice, 86400);
          return altPrice;
        }
      } catch (altErr) {
        this.logger.warn(`Alternate price API also failed: ${altErr.message}`);
      }

      // If we have a last known good price, use that
      const lastKnownGoodPrice = this.cache.get<number>('last_known_good_ada_price');
      if (lastKnownGoodPrice !== undefined) {
        return lastKnownGoodPrice;
      }

      // Use fallback price instead of throwing error
      this.logger.warn(`Using fallback ADA price: ${fallbackPrice}`);
      return fallbackPrice;
    }
  }

  async getWalletAssetsQuantity(walletAddress: string, assetId: string): Promise<number> {
    try {
      const addressTotal = await this.blockfrost.addressesTotal(walletAddress);
      const balances = this.calculateBalances(addressTotal);
      return balances.get(assetId) || 0;
    } catch (err) {
      this.logger.error(`Error fetching asset quantity for ${assetId}:`, err.message);
      if (err.response?.status_code === 404) {
        throw new HttpException('Wallet address not found', 404);
      }
      throw new HttpException('Failed to fetch asset quantity', 500);
    }
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
      return Buffer.from(hexName, 'hex').toString('utf8');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return hexName || 'Unknown Asset';
    }
  }

  /**
   * Get the value of an asset in ADA and USD
   * @param policyId The policy ID of the asset
   * @param assetName The asset name (hex encoded)
   * @returns Promise with the asset value in ADA and USD
   */
  async getAssetValue(policyId: string, assetName: string): Promise<{ priceAda: number; priceUsd: number }> {
    try {
      const adaPrice = await this.getAdaPrice();

      if (!this.isMainnet && this.testnetPrices[policyId]) {
        const hardcodedPriceAda = this.testnetPrices[policyId];
        return {
          priceAda: hardcodedPriceAda,
          priceUsd: hardcodedPriceAda * adaPrice,
        };
      } else if (this.isMainnet && this.mainnetPrices[policyId]) {
        const hardcodedPriceAda = this.mainnetPrices[policyId];
        return {
          priceAda: hardcodedPriceAda,
          priceUsd: hardcodedPriceAda * adaPrice,
        };
      }

      const cacheKey = `asset_value_${policyId}_${assetName}`;
      const cached = this.cache.get<{ priceAda: number; priceUsd: number }>(cacheKey);

      if (cached) return cached;

      const response = await axios.get(`${this.baseUrl}/token/price`, {
        headers: {
          'x-api-key': this.taptoolsApiKey,
        },
        params: {
          policy: policyId,
          name: assetName,
          currency: 'usd,ada',
        },
      });

      if (!response.data?.data) {
        throw new Error('Invalid response from TapTools API');
      }

      const result = {
        priceAda: Number(response.data.data.ada) || 91,
        priceUsd: Number(response.data.data.usd) || 91 * adaPrice,
      };

      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      const adaPrice = await this.getAdaPrice();
      return { priceAda: 91, priceUsd: 91 * adaPrice };
    }
  }

  /**
   * Calculate the total value of all assets in a vault
   * @param vaultId The ID of the vault
   * @param phase The phase to filter assets by - 'contribute' for contributed assets, 'acquire' for invested assets
   * @returns Promise with the vault assets summary
   */
  async calculateVaultAssetsValue(
    vaultId: string,
    phase: 'contribute' | 'acquire' = 'contribute',
    updatePrices: boolean = true
  ): Promise<VaultAssetsSummaryDto> {
    // Get the vault to verify it exists
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      relations: ['assets', 'owner'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault with ID ${vaultId} not found`);
    }

    // Group assets by policyId and assetId to handle quantities
    const assetMap = new Map<
      string,
      {
        policyId: string;
        assetId: string;
        quantity: number;
        isNft: boolean;
        metadata?: Record<string, unknown>;
      }
    >();

    let totalAcquiredAda = 0;

    // Process each asset in the vault
    for (const asset of vault.assets) {
      // Skip assets that are not in a valid status for valuation or don't match the phase
      if (asset.status !== AssetStatus.PENDING && asset.status !== AssetStatus.LOCKED) {
        continue;
      }

      if (asset.origin_type === AssetOriginType.ACQUIRED && asset.policy_id === 'lovelace') {
        totalAcquiredAda += Number(asset.quantity);
      }

      // Filter assets based on phase
      if (
        (phase === 'contribute' && asset.origin_type !== AssetOriginType.CONTRIBUTED) ||
        (phase === 'acquire' && asset.origin_type !== AssetOriginType.ACQUIRED)
      ) {
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
        assetMap.set(key, {
          policyId: asset.policy_id,
          assetId: asset.asset_id,
          quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
          isNft: asset.type === AssetType.NFT,
          metadata: asset.metadata || {},
        });
      }
    }

    // Convert map to array for processing
    const assets = Array.from(assetMap.values());

    // Get asset values from TapTools
    const assetsWithValues = [];
    let totalValueAda = 0;
    let totalValueUsd = 0;

    for (const asset of assets) {
      try {
        // TODO: Test this
        if (asset.assetId === 'lovelace') {
          // Special case for ADA

          const adaPrice = await this.getAdaPrice();
          const totalAdaValue = asset.quantity * 1e-6; // Convert lovelace to ADA

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
        // Get asset value in ADA
        const assetValue = await this.getAssetValue(asset.policyId, asset.assetId);

        const valueAda = assetValue?.priceAda || 0;
        const valueUsd = assetValue?.priceUsd || 0;

        // Calculate total value for this asset
        const totalAssetValueAda = valueAda * asset.quantity;
        const totalAssetValueUsd = valueUsd * asset.quantity;

        assetsWithValues.push({
          ...asset,
          assetName: asset.assetId, // Using assetId as assetName for backward compatibility
          valueAda: totalAssetValueAda,
          valueUsd: totalAssetValueUsd,
        });

        totalValueAda += totalAssetValueAda;
        totalValueUsd += totalAssetValueUsd;
      } catch (error) {
        // Skip assets that can't be valued
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

    const adaPrice = await this.getAdaPrice();

    // Create and return the summary
    const summary: VaultAssetsSummaryDto = {
      totalValueAda: +totalValueAda.toFixed(6),
      totalValueUsd: +totalValueUsd.toFixed(2),
      totalAssets: assetsWithValues.length,
      nfts: assetsWithValues.filter(a => a.isNft).length,
      tokens: assetsWithValues.filter(a => !a.isNft).length,
      lastUpdated: new Date().toISOString(),
      totalAcquiredAda,
      totalAcquiredUsd: totalAcquiredAda * adaPrice,
      adaPrice,
      assets: assetsWithValues.map(asset => ({
        policyId: asset.policyId,
        assetName: asset.assetId, // Using assetId as assetName for backward compatibility
        quantity: asset.quantity,
        valueAda: asset.valueAda,
        valueUsd: asset.valueUsd,
        isNft: asset.isNft,
        metadata: asset.metadata,
      })),
    };

    return summary;
  }

  /**
   * Batch calculate vault assets values for multiple vaults
   * Much more efficient than calling calculateVaultAssetsValue() for each vault
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

      const adaPrice = await this.getAdaPrice();

      // Process each vault
      for (const vault of vaults) {
        let totalValueAda = 0;
        let totalValueUsd = 0;
        let totalAcquiredAda = 0;

        // Group assets by policyId and assetId
        const assetMap = new Map<
          string,
          {
            policyId: string;
            assetId: string;
            quantity: number;
            isNft: boolean;
          }
        >();

        for (const asset of vault.assets) {
          // Skip invalid statuses
          if (asset.status !== AssetStatus.PENDING && asset.status !== AssetStatus.LOCKED) {
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
            assetMap.set(key, {
              policyId: asset.policy_id,
              assetId: asset.asset_id,
              quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
              isNft: asset.type === AssetType.NFT,
            });
          }
        }

        // Calculate values for all assets
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

            // Get asset value
            const assetValue = await this.getAssetValue(asset.policyId, asset.assetId);
            const valueAda = assetValue?.priceAda || 0;
            const valueUsd = assetValue?.priceUsd || 0;

            totalValueAda += valueAda * asset.quantity;
            totalValueUsd += valueUsd * asset.quantity;
          } catch (error) {
            // Skip assets that can't be valued
            this.logger.debug(`Could not value asset ${asset.policyId}.${asset.assetId}: ${error.message}`);
          }
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
    const { address: walletAddress, page, limit, filter, whitelistedPolicies } = paginationQuery;

    try {
      const adaPriceUsd = await this.getAdaPrice();

      // Get overview (cached)
      const overview = await this.getWalletOverview(walletAddress, adaPriceUsd);

      // Get paginated assets
      const { assets, pagination } = await this.getPaginatedAssets(
        walletAddress,
        page,
        limit,
        filter,
        whitelistedPolicies
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
      // Validate address
      await this.blockfrost.addresses(walletAddress);

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
    whitelistedPolicies: string[]
  ): Promise<{ assets: AssetValueDto[]; pagination: PaginationMetaDto }> {
    try {
      // Get all asset units (cached)
      const allAssetUnits = await this.getAllAssetUnits(walletAddress);

      // Filter based on type
      let filteredAssets = this.filterAssetsByType(allAssetUnits, filter);

      if (whitelistedPolicies.length > 0) {
        filteredAssets = filteredAssets.filter(asset => {
          // Extract policy ID from unit (first 56 characters)
          const policyId = asset.unit.substring(0, 56);
          return whitelistedPolicies.includes(policyId);
        });
      }

      // Calculate pagination
      const total = filteredAssets.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      const pageAssets = filteredAssets.slice(offset, offset + limit);

      const processedAssets = await this.processAssetsPage(pageAssets);

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

      return { assets: processedAssets, pagination };
    } catch (err) {
      this.logger.error('Error getting paginated assets:', err.message);
      throw new HttpException('Failed to fetch paginated assets', 500);
    }
  }

  private async getAllAssetUnits(walletAddress: string): Promise<Array<{ unit: string; quantity: number }>> {
    const cacheKey = `wallet_assets_${walletAddress}`;
    const cached = this.cache.get<Array<{ unit: string; quantity: number }>>(cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const addressTotal = await this.blockfrost.addressesTotal(walletAddress);

      const balances = this.calculateBalances(addressTotal);
      const assetUnits = Array.from(balances.entries())
        .filter(([unit, balance]) => unit !== 'lovelace' && balance > 0)
        .map(([unit, quantity]) => ({ unit, quantity }));

      // Cache for 2 minutes
      this.cache.set(cacheKey, assetUnits, 120);
      return assetUnits;
    } catch (err) {
      this.logger.error('Error fetching all asset units:', err.message);
      throw new HttpException('Failed to fetch asset units', 500);
    }
  }

  private filterAssetsByType(
    assets: Array<{ unit: string; quantity: number }>,
    filter: 'all' | 'nfts' | 'tokens'
  ): Array<{ unit: string; quantity: number }> {
    if (filter === 'nfts') {
      return assets.filter(asset => asset.quantity === 1);
    }
    if (filter === 'tokens') {
      return assets.filter(asset => asset.quantity > 1);
    }
    return assets; // 'all'
  }

  private async processAssetsPage(pageAssets: Array<{ unit: string; quantity: number }>): Promise<AssetValueDto[]> {
    const processedAssets: AssetValueDto[] = [];

    // Process assets directly without batching - pagination already limits the number
    for (const asset of pageAssets) {
      const assetDetailsResult = await this.fetchAssetDetailsFromApi(asset.unit);

      const { priceAda, priceUsd } = await this.getAssetValue(
        assetDetailsResult?.details.policy_id || asset.unit.substring(0, 56),
        assetDetailsResult?.details.asset_name || asset.unit.substring(56)
      );

      if (!assetDetailsResult) {
        throw new HttpException(`Failed to fetch asset details for ${asset.unit}`, 500);
      }

      const details = assetDetailsResult.details;
      const metadata = details.onchain_metadata || details.metadata || {};
      const assetName = this.decodeAssetName(details.asset_name || asset.unit.substring(56));

      const assetData: AssetValueDto = {
        tokenId: asset.unit,
        name: assetName,
        displayName: String((metadata as Record<string, unknown>)?.name || assetName),
        ticker: String(details.metadata?.ticker || ''),
        quantity: asset.quantity,
        isNft: asset.quantity === 1,
        isFungibleToken: asset.quantity > 1,
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
   * Get unique policy IDs from wallet
   *
   * (Implement better logic to exclude FTs)
   */
  async getWalletPolicyIds(
    walletAddress: string,
    excludeFTs: boolean
  ): Promise<Array<{ policyId: string; name: string }>> {
    try {
      const addressInfo = await this.blockfrost.addresses(walletAddress);

      const uniquePolicies = new Map<string, string>();

      for (const asset of addressInfo.amount) {
        if (asset.unit === 'lovelace' || (excludeFTs && +asset.quantity > 1)) {
          continue;
        }

        // Extract policy ID (first 56 characters of the unit)
        const policyId = asset.unit.substring(0, 56);

        // Skip if we already have this policy ID
        if (uniquePolicies.has(policyId)) {
          continue;
        }

        // Extract asset name from unit (after policy ID)
        const assetNameHex = asset.unit.substring(56);
        const assetName = this.decodeAssetName(assetNameHex);

        // Use a simple policy name based on the first asset found for this policy
        const policyName = assetName || `Policy ${policyId.substring(0, 8)}...`;

        uniquePolicies.set(policyId, policyName);
      }

      return Array.from(uniquePolicies.entries()).map(([policyId, name]) => ({
        policyId,
        name,
      }));
    } catch (error) {
      this.logger.error(`Error fetching wallet policy IDs for ${walletAddress}:`, error.message);

      if (error.response?.status_code === 404) {
        throw new HttpException('Wallet address not found', 404);
      }

      throw new HttpException('Failed to fetch wallet policy IDs', 500);
    }
  }
}
