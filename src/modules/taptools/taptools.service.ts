import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosInstance } from 'axios';
import { plainToInstance } from 'class-transformer';
import NodeCache from 'node-cache';
import { In, Repository } from 'typeorm';

import { DexHunterPricingService } from '../dexhunter/dexhunter-pricing.service';
import { MarketService } from '../market/market.service';
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
import { AssetsService } from '@/modules/vaults/assets/assets.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { VaultStatus } from '@/types/vault.types';

@Injectable()
export class TaptoolsService {
  private readonly logger = new Logger(TaptoolsService.name);

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
  private readonly axiosTapToolsInstance: AxiosInstance;
  private readonly tapToolsApiKey: string;
  private readonly tapToolsApiUrl: string;

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
    private readonly configService: ConfigService,
    private readonly dexHunterPricingService: DexHunterPricingService,
    private readonly wayUpPricingService: WayUpPricingService,
    private readonly marketService: MarketService
  ) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
    this.axiosTapToolsInstance = axios.create({
      baseURL: this.tapToolsApiUrl,
      headers: {
        'x-api-key': this.tapToolsApiKey,
      },
    });
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
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
   * Get the value of an asset in ADA and USD
   * Uses DexHunter for fungible tokens and WayUp for NFT floor prices
   * @param policyId The policy ID of the asset
   * @param assetName The asset name (hex encoded)
   * @returns Promise with the asset value in ADA and USD
   */
  async getAssetValue(
    policyId: string,
    assetName: string,
    isNFT: boolean
  ): Promise<{ priceAda: number; priceUsd: number }> {
    try {
      const adaPrice = await this.getAdaPrice();

      if (!this.isMainnet && this.testnetPrices[policyId]) {
        const hardcodedPriceAda = this.testnetPrices[policyId];
        return {
          priceAda: hardcodedPriceAda,
          priceUsd: hardcodedPriceAda * adaPrice,
        };
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
    } catch (error) {
      this.logger.error(`Failed to get asset value for ${policyId}:`, error.message);
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
   * Uses controlled concurrency to avoid overwhelming external APIs
   * @param vaultIds Optional array of vault IDs to update assets for. If not provided, updates all active vaults
   */
  async updateAssetPrices(vaultIds?: string[]): Promise<void> {
    try {
      // Build query to get unique assets across specified vaults
      let query = this.assetRepository
        .createQueryBuilder('asset')
        .select(['asset.policy_id', 'asset.asset_id', 'asset.type'])
        .where('asset.status IN (:...statuses)', { statuses: [AssetStatus.PENDING, AssetStatus.LOCKED] })
        .andWhere('asset.deleted = false')
        .groupBy('asset.policy_id, asset.asset_id, asset.type');

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
              // Get floor price from WayUp for NFTs
              try {
                const { floorPriceAda } = await this.wayUpPricingService.getCollectionFloorPrice(asset.asset_policy_id);
                priceAda = floorPriceAda > 0 ? floorPriceAda : null;
              } catch (error) {
                this.logger.debug(`Failed to get floor price for NFT ${asset.asset_policy_id}: ${error.message}`);
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

    const adaPrice = await this.getAdaPrice();

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
      }
    >();

    let totalAcquiredAda = 0;

    // Group assets and track acquired ADA in one pass
    for (const asset of vault.assets) {
      if (asset.origin_type === AssetOriginType.ACQUIRED && asset.policy_id === 'lovelace') {
        totalAcquiredAda += Number(asset.quantity);
      }

      // Skip assets that are not in a valid status for valuation
      if (asset.status !== AssetStatus.PENDING && asset.status !== AssetStatus.LOCKED) {
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
          const assetValue = await this.getAssetValue(asset.policyId, asset.assetId, asset.isNft);
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
    };
  }

  /**
   * Update cached vault totals for multiple vaults
   * Also calculates user TVL and gains based on:
   * - For locked vaults: VT token holdings (proportional ownership)
   * - For active vaults: Contributed asset values
   * For locked vaults, also calculates FDV/TVL ratio
   * @param vaultIds Array of vault IDs to update
   */
  async updateMultipleVaultTotals(vaultIds: string[]): Promise<void> {
    if (vaultIds.length === 0) return;

    const batchResults = await this.batchCalculateVaultAssetsValue(vaultIds);
    const adaPrice = await this.getAdaPrice();

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
        total_acquired_value_ada: summary.totalAcquiredAda,
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
            .andWhere('asset.status IN (:...statuses)', { statuses: [AssetStatus.LOCKED, AssetStatus.DISTRIBUTED] })
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
                status: In([AssetStatus.LOCKED, AssetStatus.DISTRIBUTED]),
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

      const adaPrice = await this.getAdaPrice();

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
            // Use cached price from database
            const cachedPrice = asset.type === AssetType.NFT ? asset.floor_price : asset.dex_price;

            assetMap.set(key, {
              policyId: asset.policy_id,
              assetId: asset.asset_id,
              quantity: asset.type === AssetType.NFT ? 1 : Number(asset.quantity),
              isNft: asset.type === AssetType.NFT,
              cachedPrice: cachedPrice ? Number(cachedPrice) : undefined,
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
              const assetValue = await this.getAssetValue(asset.policyId, asset.assetId, asset.isNft);
              valueAda = assetValue?.priceAda || 0;
            }

            totalValueAda += valueAda * asset.quantity;
            totalValueUsd += valueAda * adaPrice * asset.quantity;
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
    const { address: walletAddress, page, limit, filter, whitelistedPolicies, search } = paginationQuery;

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
    whitelistedPolicies: string[],
    search?: string
  ): Promise<{ assets: AssetValueDto[]; pagination: PaginationMetaDto }> {
    try {
      // Get all asset units (cached)
      const filteredAssets = await this.getFilteredUnits(walletAddress, whitelistedPolicies);

      // Calculate pagination
      const total = filteredAssets.length;
      const totalPages = Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      const pageAssets = filteredAssets.slice(offset, offset + limit);

      const processedAssets = await this.processAssetsPage(pageAssets, filter, search);

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

  private async getFilteredUnits(
    walletAddress: string,
    whitelistedPolicies: string[]
  ): Promise<{ unit: string; quantity: number }[]> {
    const cacheKey = `wallet_assets_${walletAddress}`;
    const cached = this.cache.get<Array<{ unit: string; quantity: number }>>(cacheKey);

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
        this.cache.set(cacheKey, assetUnits, 120);
      } catch (err) {
        this.logger.error('Error fetching all asset units:', err.message);
        throw new HttpException('Failed to fetch asset units', 500);
      }
    }

    const filteredUnits = whitelistedPolicies.length
      ? assetUnits.filter(asset => whitelistedPolicies.includes(asset.unit.substring(0, 56)))
      : assetUnits;

    return filteredUnits;
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

      const { priceAda, priceUsd } = await this.getAssetValue(
        assetDetailsResult?.details.policy_id || asset.unit.substring(0, 56),
        assetDetailsResult?.details.asset_name || asset.unit.substring(56),
        isNFT
      );

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
   * Determine if an asset is an NFT or Fungible Token
   * Uses multiple heuristics for accurate detection
   * @param assetDetails Asset details from Blockfrost
   * @returns true if NFT, false if FT
   */
  private isNFT(assetDetails: BlockfrostAssetResponseDto): boolean {
    // 1. Check total quantity (most reliable)
    if (assetDetails.quantity === '1') {
      return true;
    }

    // 2. Check for NFT metadata (CIP-25)
    const metadata = assetDetails.onchain_metadata;
    if (metadata) {
      // Presence of image or files indicates NFT
      if (metadata.image || metadata.files) {
        return true;
      }

      // Presence of decimals indicates FT
      if (assetDetails.metadata.decimals !== undefined) {
        return false;
      }

      // Check for media-related fields (NFT indicators)
      if (metadata.mediaType || metadata.attributes) {
        return true;
      }
    }

    // 3. Fallback: If quantity > 1, assume FT
    const qty = parseInt(assetDetails.quantity);
    return qty === 1;
  }

  @Cron(CronExpression.EVERY_2_HOURS)
  async scheduledUpdateVaultTokensMarketStats(): Promise<void> {
    this.logger.log('Scheduled task: Starting vault tokens market stats update');
    try {
      await this.getVaultTokensMarketStats();
    } catch (error) {
      this.logger.error(
        'Scheduled task: Failed to update vault tokens market stats',
        error instanceof Error ? error.stack : undefined
      );
    }
  }

  async getVaultTokensMarketStats(): Promise<void> {
    if (!this.isMainnet) {
      this.logger.log('Not mainnet environment - skipping vault tokens market stats update');
      return;
    }
    const vaults = await this.vaultRepository
      .createQueryBuilder('v')
      .select(['v.id', 'v.policy_id', 'v.asset_vault_name', 'v.total_assets_cost_ada'])
      .where('v.vault_status = :status', { status: VaultStatus.locked })
      .andWhere('v.liquidity_pool_contribution > 0')
      .andWhere('v.policy_id IS NOT NULL')
      .andWhere('v.asset_vault_name IS NOT NULL')
      .getMany();

    if (!vaults || vaults.length === 0) {
      this.logger.warn('No vault tokens found for market stats update');
      return;
    }

    this.logger.log(`Found ${vaults.length} vaults to update market stats`);

    const tokensMarketData = await Promise.all(
      vaults.map(async vault => {
        const unit = `${vault.policy_id}${vault.asset_vault_name}`;

        try {
          const [{ data: mcapData }, { data: priceChangeData }] = await Promise.all([
            this.axiosTapToolsInstance.get('/token/mcap', { params: { unit } }),
            this.axiosTapToolsInstance.get('/token/prices/chg', {
              params: {
                unit,
                timeframes: '1h,24h,7d,30d',
              },
            }),
          ]);

          const vaultUpdateData: Partial<Vault> = {};

          if (mcapData?.fdv) {
            vaultUpdateData.fdv = mcapData.fdv;
          }

          if (mcapData?.price) {
            vaultUpdateData.vt_price = mcapData.price;
          }

          if (Object.keys(vaultUpdateData).length > 0) {
            await this.vaultRepository.update({ id: vault.id }, vaultUpdateData);
          }

          const marketData = {
            vault_id: vault.id,
            circSupply: mcapData?.circSupply || 0,
            mcap: mcapData?.mcap || 0,
            totalSupply: mcapData?.totalSupply || 0,
            price_change_1h: priceChangeData?.['1h'] || 0,
            price_change_24h: priceChangeData?.['24h'] || 0,
            price_change_7d: priceChangeData?.['7d'] || 0,
            price_change_30d: priceChangeData?.['30d'] || 0,
            tvl: vault.total_assets_cost_ada,
          };

          await this.marketService.upsertMarketData(marketData);

          return { vault_id: vault.id, ...marketData, ...vaultUpdateData };
        } catch (error) {
          this.logger.error(`Error fetching TapTools data for unit ${unit}:`, error.response?.data || error.message);
          return null;
        }
      })
    );

    const successfulUpdates = tokensMarketData.filter(data => data !== null).length;
    this.logger.log(`Successfully updated market stats for ${successfulUpdates} vault tokens`);
  }
}
