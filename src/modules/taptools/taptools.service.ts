import { Injectable, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { Repository } from 'typeorm';

import { AssetsService } from '../vaults/processing-tx/assets/assets.service';
import { VaultAssetsSummaryDto } from '../vaults/processing-tx/offchain-tx/dto/vault-assets-summary.dto';

import { AssetValueDto, BlockfrostAssetResponseDto } from './dto/asset-value.dto';
import { BlockfrostAddressTotalDto, BlockfrostAddressDto } from './dto/blockfrost-address.dto';
import { PaginationQueryDto, PaginationMetaDto } from './dto/pagination.dto';
import { WalletOverviewDto, PaginatedWalletSummaryDto } from './dto/wallet-summary.dto';

import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);
  private readonly baseUrl = 'https://openapi.taptools.io/api/v1';
  private readonly blockfrostTestnetUrl = 'https://cardano-preprod.blockfrost.io/api/v0/';
  private readonly taptoolsApiKey: string;
  private cache = new NodeCache({ stdTTL: 600 }); // cache for 10 minutes to reduce API calls for ADA price

  private readonly blockfrostClient: AxiosInstance;
  private assetDetailsCache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });

  private readonly slackWebhookUrl = process.env.SLACK_BOT_TOKEN;
  private readonly slackChannel = `#${process.env.SLACK_CHANNEL}`;
  private readonly SLACK_ALERT_COOLDOWN = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
  private lastSlackAlert = new Map<string, number>();

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
        // Send Slack alert for 429 errors (rate limiting)
        if (error.response?.status === 429) {
          await this.sendSlackAlert('rate_limit', {
            service: 'Blockfrost API',
            status: 429,
            message: 'Rate limit exceeded',
            endpoint: config?.url || 'unknown',
            timestamp: new Date().toISOString(),
          });
        }

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
      // Use the more efficient /total endpoint
      const response = await this.blockfrostClient.get<BlockfrostAddressTotalDto>(`/addresses/${walletAddress}/total`);

      if (response.status === 200) {
        const balances = this.calculateBalances(response.data);
        return balances.get(assetId) || 0;
      }

      return 0;
    } catch (err) {
      this.logger.error(`Error fetching asset quantity for ${assetId}:`, err.message);
      if (err.response?.status === 404) {
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
      // Use the configured Blockfrost client (includes retry and rate limiting)
      const response = await this.blockfrostClient.get<BlockfrostAssetResponseDto>(`/assets/${assetId}`);

      if (response.status !== 200) {
        this.logger.warn(`Asset ${assetId} not found or API forbidden`);
        return null;
      }

      // Cache successful response
      this.assetDetailsCache.set(cacheKey, response.data);

      return { details: response.data, cached: false };
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

  async getWalletSummaryPaginated(paginationQuery: PaginationQueryDto): Promise<PaginatedWalletSummaryDto> {
    const { address: walletAddress, page, limit, filter, whitelistedPolicies } = paginationQuery;

    try {
      const adaPriceUsd = await this.getAdaPrice();

      if (this.isTestnetAddress(walletAddress)) {
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
      } else {
        throw new HttpException('Only testnet addresses are supported', 400);
      }
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
      const addressCheck = await this.blockfrostClient.get<BlockfrostAddressDto>(`/addresses/${walletAddress}`);
      if (addressCheck.status !== 200) {
        throw new HttpException('Invalid wallet address', 400);
      }

      // Get totals
      const assetsResponse = await this.blockfrostClient.get<BlockfrostAddressTotalDto>(
        `/addresses/${walletAddress}/total`
      );

      if (assetsResponse.status !== 200) {
        throw new HttpException('Failed to fetch wallet totals', 500);
      }

      const balances = this.calculateBalances(assetsResponse.data);
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
      if (err.response?.status === 404) {
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
      const assetsResponse = await this.blockfrostClient.get<BlockfrostAddressTotalDto>(
        `/addresses/${walletAddress}/total`
      );

      if (assetsResponse.status !== 200) {
        throw new HttpException('Failed to fetch wallet assets', 500);
      }

      const balances = this.calculateBalances(assetsResponse.data);
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
        priceAda: 0,
        priceUsd: 0,
        valueAda: 0,
        valueUsd: 0,
        metadata: {
          policyId: details.policy_id,
          fingerprint: details.fingerprint,
          decimals: details.metadata?.decimals || 0,
          description: String((metadata as Record<string, unknown>)?.description || ''),
          image: String((metadata as Record<string, unknown>)?.image || ''),
          mediaType: String((metadata as Record<string, unknown>)?.mediaType || ''),
          files: Array.isArray(details.onchain_metadata?.files) ? details.onchain_metadata.files : [],
          attributes: ((metadata as Record<string, unknown>)?.attributes as Record<string, any>) || {},
          assetName: details.asset_name,
          mintTx: details.initial_mint_tx_hash,
          mintQuantity: details.quantity,
          onchainMetadata: details.onchain_metadata || {},
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
      const response = await this.blockfrostClient.get<BlockfrostAddressDto>(`/addresses/${walletAddress}`);

      if (response.status !== 200) {
        throw new HttpException('Wallet address not found', 404);
      }

      const uniquePolicies = new Map<string, string>();

      for (const asset of response.data.amount) {
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

      if (error.response?.status === 404) {
        throw new HttpException('Wallet address not found', 404);
      }

      throw new HttpException('Failed to fetch wallet policy IDs', 500);
    }
  }

  /**
   * Send Slack alert with rate limiting to prevent spam
   */
  private async sendSlackAlert(alertType: string, data: Record<string, any>): Promise<void> {
    try {
      // Check if we're in cooldown period for this alert type
      const lastAlert = this.lastSlackAlert.get(alertType) || 0;
      const now = Date.now();

      if (now - lastAlert < this.SLACK_ALERT_COOLDOWN) {
        this.logger.error(`Slack alert for ${alertType} is in cooldown period`);
        return;
      }

      // Don't send alerts if token is not configured
      if (!this.slackWebhookUrl) {
        this.logger.warn('Slack bot token not configured, skipping alert');
        return;
      }

      const message = this.formatSlackMessage(alertType, data);

      const response = await axios.post(
        'https://slack.com/api/chat.postMessage',
        {
          channel: this.slackChannel,
          text: message.text,
          blocks: message.blocks,
        },
        {
          headers: {
            Authorization: `Bearer ${this.slackWebhookUrl}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000, // 5 second timeout for Slack API
        }
      );

      if (response.data.ok) {
        this.lastSlackAlert.set(alertType, now);
        this.logger.log(`Slack alert sent successfully for ${alertType}`);
      } else {
        this.logger.error(`Failed to send Slack alert: ${response.data.error}`);
      }
    } catch (error) {
      this.logger.error(`Error sending Slack alert: ${error.message}`);
    }
  }

  /**
   * Format Slack message with rich formatting
   */
  private formatSlackMessage(
    alertType: string,
    data: Record<string, any>
  ): {
    text: string;
    blocks: any[];
  } {
    const timestamp = new Date().toLocaleString();

    switch (alertType) {
      case 'rate_limit':
        return {
          text: `🚨 Blockfrost API Rate Limit Alert`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: '🚨 Blockfrost API Rate Limit Exceeded',
              },
            },
            {
              type: 'section',
              fields: [
                {
                  type: 'mrkdwn',
                  text: `*Service:* ${data.service}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Status:* ${data.status}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Endpoint:* ${data.endpoint}`,
                },
                {
                  type: 'mrkdwn',
                  text: `*Time:* ${timestamp}`,
                },
              ],
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Message:* ${data.message}\n\n_This alert is rate-limited to once every ${this.SLACK_ALERT_COOLDOWN / 1000 / 60 / 60} hours._`,
              },
            },
          ],
        };

      default:
        return {
          text: `Alert: ${alertType}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Alert:* ${alertType}\n*Data:* \`${JSON.stringify(data, null, 2)}\`\n*Time:* ${timestamp}`,
              },
            },
          ],
        };
    }
  }
}
