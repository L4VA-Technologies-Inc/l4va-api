import { Injectable, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosInstance } from 'axios';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import { AssetsService } from '../vaults/processing-tx/assets/assets.service';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';

import { AssetDetailsDto } from './dto/asset-details.dto';
import { AssetValueDto, BlockfrostAssetResponseDto } from './dto/asset-value.dto';
import { BlockfrostAddressDto, BlockfrostAddressTotalDto } from './dto/blockfrost-address.dto';
import { PaginationMetaDto, PaginationQueryDto } from './dto/pagination.dto';
import { PaginatedWalletSummaryDto, WalletOverviewDto } from './dto/wallet-summary.dto';

import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);
  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private readonly blockfrostTestnetUrl = 'https://cardano-preprod.blockfrost.io/api/v0/';
  private readonly taptoolsApiKey: string;
  private cache = new NodeCache({ stdTTL: 540 }); // cache for 540 seconds to reduce API calls for ADA price (9 minutes)

  private readonly blockfrostClient: AxiosInstance;

  private assetDetailsCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly assetsService: AssetsService
  ) {
    this.taptoolsApiKey = process.env.TAPTOOLS_API_KEY || '';

    // Configure Blockfrost client with proper configuration
    this.blockfrostClient = axios.create({
      baseURL: this.blockfrostTestnetUrl,
      timeout: 10000,
      headers: {
        project_id: process.env.BLOCKFROST_TESTNET_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for rate limiting
    let lastRequestTime = 0;
    const minRequestInterval = 15; // 15ms between requests (~60-67 req/sec)

    this.blockfrostClient.interceptors.request.use(async config => {
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;

      if (timeSinceLastRequest < minRequestInterval) {
        const delay = minRequestInterval - timeSinceLastRequest;
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      lastRequestTime = Date.now();
      return config;
    });

    // Add response interceptor for error handling
    this.blockfrostClient.interceptors.response.use(
      response => response,
      async (error: AxiosError) => {
        const config = error.config;

        // Retry logic for rate limits and server errors
        if (config && this.shouldRetry(error)) {
          const retryCount = (config as any).__retryCount || 0;

          if (retryCount < 3) {
            (config as any).__retryCount = retryCount + 1;

            // Exponential backoff
            const delay = Math.pow(2, retryCount) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));

            return this.blockfrostClient.request(config);
          }
        }

        // Handle 403 errors gracefully
        if (error.response?.status === 403) {
          this.logger.warn(`Blockfrost API access forbidden: ${config?.url}`);
          return Promise.resolve({
            data: null,
            error: 'API_FORBIDDEN',
            status: 403,
          } as any);
        }

        return Promise.reject(error);
      }
    );
  }

  private shouldRetry(error: AxiosError): boolean {
    return !!(
      error.response?.status === 429 || // Rate limited
      error.response?.status === 503 || // Service unavailable
      (error.response?.status && error.response.status >= 500) || // Server errors
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    );
  }

  private isTestnetAddress(address: string): boolean {
    return address.startsWith('addr_test');
  }

  async getAdaPrice(): Promise<number> {
    const cacheKey = 'ada_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);
    if (cachedPrice !== undefined) return cachedPrice;

    try {
      const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'cardano',
          vs_currencies: 'usd',
        },
      });

      if (!response.data?.cardano?.usd) {
        throw new HttpException('Invalid price data from API', 400);
      }

      const adaPrice = Number(response.data.cardano.usd);
      this.cache.set(cacheKey, adaPrice);
      return adaPrice;
    } catch (err) {
      console.error('Error fetching ADA price:', err.message);
      throw new HttpException('Failed to fetch ADA price', 500);
    }
  }

  async getAssetDetails(assetId: string): Promise<AssetDetailsDto | null> {
    try {
      // Check cache first
      const cacheKey = `asset_details_${assetId}`;
      const cached = this.assetDetailsCache.get<BlockfrostAssetResponseDto>(cacheKey);

      if (cached) {
        return this.transformToAssetDetailsDto(cached, true);
      }

      const response = await this.blockfrostClient.get<BlockfrostAssetResponseDto>(`/assets/${assetId}`);

      if ((response as any).error) {
        this.logger.warn(`Asset ${assetId} not found or API forbidden`);
        return this.createFallbackAssetDetails(assetId);
      }

      // Cache successful response
      this.assetDetailsCache.set(cacheKey, response.data);

      return this.transformToAssetDetailsDto(response.data, false);
    } catch (err) {
      this.logger.error(`Error fetching asset details for ${assetId}:`, err.message);
      return this.createFallbackAssetDetails(assetId);
    }
  }

  private transformToAssetDetailsDto(
    blockfrostData: BlockfrostAssetResponseDto,
    cached: boolean = false
  ): AssetDetailsDto {
    const quantity = parseInt(blockfrostData.quantity, 10);
    const isNft = quantity === 1;
    const decodedName = this.decodeAssetName(blockfrostData.asset_name || '');

    return {
      ...blockfrostData,
      decodedName,
      isNft,
      isFungibleToken: !isNft,
      cached,
      fallback: false,
    };
  }

  private createFallbackAssetDetails(assetId: string): AssetDetailsDto {
    const policyId = assetId.substring(0, 56);
    const assetName = assetId.substring(56);
    const decodedName = this.decodeAssetName(assetName);

    return {
      asset: assetId,
      policy_id: policyId,
      asset_name: assetName,
      fingerprint: `asset_${assetId.substring(0, 10)}`,
      quantity: '1',
      initial_mint_tx_hash: 'unknown',
      mint_or_burn_count: 0,
      onchain_metadata: {
        name: decodedName,
        description: 'Asset details unavailable due to API limits',
      },
      onchain_metadata_standard: null,
      onchain_metadata_extra: null,
      metadata: null,
      decodedName,
      isNft: true,
      isFungibleToken: false,
      cached: false,
      fallback: true,
    };
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

  private async getAssetDetailsWithFallback(asset: { unit: string; quantity: number }): Promise<{
    asset: { unit: string; quantity: number };
    details: BlockfrostAssetResponseDto;
    cached?: boolean;
    error?: string;
    fallback?: boolean;
  } | null> {
    // Check cache first
    const cacheKey = `asset_details_${asset.unit}`;
    const cached = this.assetDetailsCache.get(cacheKey);
    if (cached) {
      return { asset, details: cached as BlockfrostAssetResponseDto, cached: true };
    }

    try {
      // Use the configured Blockfrost client (includes retry and rate limiting)
      const response = await this.blockfrostClient.get(`/assets/${asset.unit}`);

      if ((response as any).error) {
        // API returned structured error (from our interceptor)
        return this.createFallbackResult(asset, (response as any).error);
      }

      // Cache successful response
      this.assetDetailsCache.set(cacheKey, response.data);

      return { asset, details: response.data };
    } catch (error) {
      this.logger.debug(`Failed to fetch details for asset ${asset.unit}: ${error.message}`);
      return this.createFallbackResult(asset, error.message);
    }
  }

  private createFallbackResult(asset: any, errorMessage: string): any {
    const policyId = asset.unit.substring(0, 56);
    const assetName = asset.unit.substring(56);

    return {
      asset,
      details: {
        policy_id: policyId,
        asset_name: assetName,
        fingerprint: `asset_${asset.unit.substring(0, 10)}`,
        quantity: '1',
        initial_mint_tx_hash: 'unknown',
        decimals: 0,
        onchain_metadata: {
          name: this.decodeAssetName(assetName),
          description: 'Asset details unavailable due to API limits',
        },
        metadata: {},
      },
      error: errorMessage,
      fallback: true,
    };
  }

  private createAssetDto(result: any): AssetValueDto | null {
    if (!result) return null;

    const { asset, details } = result;
    const isNft = Number(asset.quantity) === 1;
    const metadata = details.onchain_metadata || details.metadata || {};
    const assetName = this.decodeAssetName(details.asset_name || asset.unit.substring(56));

    return {
      tokenId: asset.unit,
      name: assetName,
      displayName: metadata.name || assetName,
      ticker: details.ticker,
      quantity: Number(asset.quantity),
      isNft,
      isFungibleToken: !isNft,
      priceAda: 0,
      priceUsd: 0,
      valueAda: 0,
      valueUsd: 0,
      metadata: {
        policyId: details.policy_id,
        fingerprint: details.fingerprint,
        decimals: details.decimals || 0,
        description: metadata.description,
        image: metadata.image,
        mediaType: metadata.mediaType,
        files: details.onchain_metadata?.files || [],
        attributes: metadata.attributes || {},
        assetName: details.asset_name,
        mintTx: details.initial_mint_tx_hash,
        mintQuantity: details.quantity,
        onchainMetadata: details.onchain_metadata || {},
      },
    };
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

      // Hardcoded testnet policy IDs and their prices
      const testnetPrices: Record<string, number> = {
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

      if (testnetPrices[policyId]) {
        const hardcodedPriceAda = testnetPrices[policyId];
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // No value on Preprod
      // console.error(`Error fetching asset value for ${policyId}.${assetName}:`, error.message);
      // Return zero values if the asset is not found or there's an error
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
      relations: ['assets'],
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
        metadata?: Record<string, any>;
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
      await this.assetsService.updateAssetValuations(
        assetsWithValues.map(asset => ({
          policyId: asset.policyId,
          assetId: asset.assetId,
          valueAda: asset.valueAda / asset.quantity, // Get per-unit price
          isNft: asset.isNft,
        }))
      );
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

  async getWalletSummaryPaginated(
    walletAddress: string,
    paginationQuery: PaginationQueryDto
  ): Promise<PaginatedWalletSummaryDto> {
    const { page = 1, limit = 20, filter = 'all' } = paginationQuery;

    try {
      const adaPriceUsd = await this.getAdaPrice();

      if (this.isTestnetAddress(walletAddress)) {
        return await this.getTestnetWalletSummaryPaginated(walletAddress, adaPriceUsd, page, limit, filter);
      } else {
        return await this.getMainnetWalletSummaryPaginated(walletAddress, adaPriceUsd, page, limit, filter);
      }
    } catch (err) {
      console.error('Error fetching paginated wallet summary:', err.message);
      if (axios.isAxiosError(err)) {
        throw new HttpException(
          err.response?.data?.message || 'Failed to fetch wallet assets',
          err.response?.status || 500
        );
      }
      throw new HttpException('Failed to fetch or process wallet assets', 500);
    }
  }

  private async getTestnetWalletSummaryPaginated(
    walletAddress: string,
    adaPriceUsd: number,
    page: number,
    limit: number,
    filter: 'all' | 'nfts' | 'tokens'
  ): Promise<PaginatedWalletSummaryDto> {
    // First, get or create overview (cached)
    const overviewCacheKey = `wallet_overview_${walletAddress}`;
    let overview = this.cache.get<WalletOverviewDto>(overviewCacheKey);

    if (!overview) {
      // Create overview by getting basic wallet info
      try {
        const addressCheck = await this.blockfrostClient.get<BlockfrostAddressDto>(`/addresses/${walletAddress}`);
        if (addressCheck.status !== 200) {
          return this.getEmptyPaginatedWalletSummary(walletAddress, page, limit);
        }
      } catch (err) {
        this.logger.log('Error validating address:', err.message);
        return this.getEmptyPaginatedWalletSummary(walletAddress, page, limit);
      }

      try {
        // Get all assets to calculate totals
        const assetsResponse = await this.blockfrostClient.get<BlockfrostAddressTotalDto>(
          `/addresses/${walletAddress}/total`
        );

        if ((assetsResponse as any).error) {
          throw new Error('Failed to fetch wallet assets');
        }

        // Calculate balances and totals for overview
        const balances = this.calculateBalances(assetsResponse.data);
        const totalAda = (balances.get('lovelace') || 0) / 1000000;
        const totalUsd = totalAda * adaPriceUsd;

        const nonAdaAssets = Array.from(balances.entries()).filter(
          ([unit, balance]) => unit !== 'lovelace' && balance > 0
        );

        // Count NFTs vs Tokens by checking quantity
        let nftCount = 0;
        let tokenCount = 0;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [_unit, quantity] of nonAdaAssets) {
          if (quantity === 1) {
            nftCount++;
          } else {
            tokenCount++;
          }
        }

        overview = {
          wallet: walletAddress,
          totalValueAda: +totalAda.toFixed(4),
          totalValueUsd: +totalUsd.toFixed(4),
          lastUpdated: new Date().toISOString(),
          summary: {
            totalAssets: nonAdaAssets.length,
            nfts: nftCount,
            tokens: tokenCount,
            ada: totalAda,
          },
        };

        // Cache overview for 5 minutes
        this.cache.set(overviewCacheKey, overview, 300);
      } catch (err) {
        this.logger.error('Error creating wallet overview:', err.message);
        return this.getEmptyPaginatedWalletSummary(walletAddress, page, limit);
      }
    }

    // Now get paginated assets
    const assetsCacheKey = `wallet_assets_${walletAddress}`;
    let allAssetUnits = this.cache.get<Array<{ unit: string; quantity: number }>>(assetsCacheKey);

    if (!allAssetUnits) {
      try {
        const assetsResponse = await this.blockfrostClient.get<BlockfrostAddressTotalDto>(
          `/addresses/${walletAddress}/total`
        );
        const balances = this.calculateBalances(assetsResponse.data);

        allAssetUnits = Array.from(balances.entries())
          .filter(([unit, balance]) => unit !== 'lovelace' && balance > 0)
          .map(([unit, quantity]) => ({ unit, quantity }));

        // Cache all asset units for 2 minutes
        this.cache.set(assetsCacheKey, allAssetUnits, 120);
      } catch (err) {
        this.logger.error('Error fetching wallet assets for pagination:', err.message);
        return this.getEmptyPaginatedWalletSummary(walletAddress, page, limit);
      }
    }

    // Filter assets based on filter parameter
    let filteredAssets = allAssetUnits;
    if (filter === 'nfts') {
      filteredAssets = allAssetUnits.filter(asset => asset.quantity === 1);
    } else if (filter === 'tokens') {
      filteredAssets = allAssetUnits.filter(asset => asset.quantity > 1);
    }

    // Calculate pagination
    const total = filteredAssets.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;

    // Get assets for current page
    const pageAssets = filteredAssets.slice(offset, offset + limit);

    // Process current page assets with details
    const processedAssets: AssetValueDto[] = [];

    // Process in smaller batches to respect rate limits
    const batchSize = 3;
    const delayBetweenBatches = 500; // 0.5 seconds between batches

    for (let i = 0; i < pageAssets.length; i += batchSize) {
      const batch = pageAssets.slice(i, i + batchSize);

      const batchPromises = batch.map(asset => this.getAssetDetailsWithFallback(asset));
      const settledResults = await Promise.allSettled(batchPromises);

      const batchResults = settledResults.map(result => (result.status === 'fulfilled' ? result.value : null));

      for (const result of batchResults) {
        if (!result || result.error) continue;

        const processedAsset = this.createAssetDto(result);
        if (processedAsset) {
          processedAssets.push(processedAsset);
        }
      }

      // Small delay between batches
      if (i + batchSize < pageAssets.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    const paginationMeta: PaginationMetaDto = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      overview,
      assets: processedAssets,
      pagination: paginationMeta,
    };
  }

  private async getMainnetWalletSummaryPaginated(
    walletAddress: string,
    adaPriceUsd: number,
    page: number,
    limit: number,
    filter: 'all' | 'nfts' | 'tokens'
  ): Promise<PaginatedWalletSummaryDto> {
    // Use TapTools API for mainnet
    const res = await axios.get(`${this.baseUrl}/wallet/portfolio/positions?address=${walletAddress}`, {
      headers: {
        'x-api-key': process.env.TAPTOOLS_API_KEY,
      },
      timeout: 15000,
    });

    if (!res.data) {
      throw new HttpException('Invalid response format from API', 400);
    }

    const totalAda = res.data.adaValue || 0;
    const totalUsd = totalAda * adaPriceUsd;

    // Process all assets first
    const allAssets: AssetValueDto[] = [];

    // Process fungible tokens
    if (res.data.positionsFt) {
      for (const ft of res.data.positionsFt) {
        allAssets.push({
          tokenId: ft.unit,
          name: ft.ticker,
          displayName: ft.ticker,
          quantity: ft.balance,
          isNft: false,
          isFungibleToken: true,
          priceAda: ft.price,
          priceUsd: ft.price * adaPriceUsd,
          valueAda: ft.adaValue,
          valueUsd: ft.adaValue * adaPriceUsd,
        });
      }
    }

    // Process NFTs
    if (res.data.positionsNft) {
      for (const nft of res.data.positionsNft) {
        allAssets.push({
          tokenId: nft.policy,
          name: nft.name,
          displayName: nft.name,
          quantity: nft.balance,
          isNft: true,
          isFungibleToken: false,
          priceAda: nft.floorPrice,
          priceUsd: nft.floorPrice * adaPriceUsd,
          valueAda: nft.adaValue,
          valueUsd: nft.adaValue * adaPriceUsd,
        });
      }
    }

    // Apply filters
    let filteredAssets = allAssets;
    if (filter === 'nfts') {
      filteredAssets = allAssets.filter(asset => asset.isNft);
    } else if (filter === 'tokens') {
      filteredAssets = allAssets.filter(asset => asset.isFungibleToken);
    }

    // Pagination
    const total = filteredAssets.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const pageAssets = filteredAssets.slice(offset, offset + limit);

    const overview: WalletOverviewDto = {
      wallet: walletAddress,
      totalValueAda: +totalAda.toFixed(4),
      totalValueUsd: +totalUsd.toFixed(4),
      lastUpdated: new Date().toISOString(),
      summary: {
        totalAssets: allAssets.length,
        nfts: allAssets.filter(a => a.isNft).length,
        tokens: allAssets.filter(a => a.isFungibleToken).length,
        ada: totalAda,
      },
    };

    const paginationMeta: PaginationMetaDto = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return {
      overview,
      assets: pageAssets,
      pagination: paginationMeta,
    };
  }

  private getEmptyPaginatedWalletSummary(
    walletAddress: string,
    page: number,
    limit: number
  ): PaginatedWalletSummaryDto {
    return {
      overview: {
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
      },
      assets: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    };
  }
}
