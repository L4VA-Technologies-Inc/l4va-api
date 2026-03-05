import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';

import { GetMarketsResponse, MarketItem, MarketItemWithOHLCV } from './dto/get-markets-response.dto';
import { Currency, GetMarketsDto, MarketSortField, SortOrder } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { PriceService } from '@/modules/price/price.service';
import { VaultMarketStatsService } from '@/modules/vaults/market-stats/vault-market-stats.service';

@Injectable()
export class MarketService implements OnModuleInit {
  private readonly logger = new Logger(MarketService.name);
  private isMainnet: boolean;

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    private readonly configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly priceService: PriceService,
    private readonly vaultMarketStatsService: VaultMarketStatsService
  ) {}

  onModuleInit(): void {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  async getMarkets(query: GetMarketsDto): Promise<GetMarketsResponse> {
    const {
      page = 1,
      limit = 10,
      sortBy,
      sortOrder = SortOrder.DESC,
      ticker,
      minPrice,
      maxPrice,
      minFdv,
      maxFdv,
      minTvl,
      maxTvl,
      minDelta,
      maxDelta,
      currency = Currency.ADA,
    } = query;

    const queryBuilder = this.marketRepository.createQueryBuilder('market');

    const adaPrice = await this.priceService.getAdaPrice();

    queryBuilder
      .leftJoinAndSelect('market.vault', 'vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags');

    // Hide vaults on mainnet that are in the hidden list
    if (this.isMainnet) {
      const hiddenIds = this.systemSettingsService.hiddenMainnetVaultIds;
      if (hiddenIds.length > 0) {
        queryBuilder.andWhere('market.vault_id NOT IN (:...hiddenIds)', { hiddenIds });
      }
    }

    if (ticker) {
      queryBuilder.andWhere('vault.vault_token_ticker ILIKE :ticker', {
        ticker: `%${ticker}%`,
      });
    }

    if (minPrice != null || maxPrice != null) {
      let minPriceFilter: number | null = minPrice ?? null;
      let maxPriceFilter: number | null = maxPrice ?? null;
      if (currency === Currency.USD) {
        const safeAdaPrice = adaPrice > 0 ? adaPrice : 1;
        minPriceFilter = minPrice != null ? minPrice / safeAdaPrice : null;
        maxPriceFilter = maxPrice != null ? maxPrice / safeAdaPrice : null;
      }
      if (minPriceFilter != null && maxPriceFilter != null) {
        queryBuilder.andWhere('vault.vt_price BETWEEN :minPrice AND :maxPrice', {
          minPrice: minPriceFilter,
          maxPrice: maxPriceFilter,
        });
      } else if (minPriceFilter != null) {
        queryBuilder.andWhere('vault.vt_price >= :minPrice', { minPrice: minPriceFilter });
      } else if (maxPriceFilter != null) {
        queryBuilder.andWhere('vault.vt_price <= :maxPrice', { maxPrice: maxPriceFilter });
      }
    }

    if (minFdv != null || maxFdv != null) {
      let minFdvFilter: number | null = minFdv ?? null;
      let maxFdvFilter: number | null = maxFdv ?? null;
      if (currency === Currency.USD) {
        const safeAdaPrice = adaPrice > 0 ? adaPrice : 1;
        minFdvFilter = minFdv != null ? minFdv / safeAdaPrice : null;
        maxFdvFilter = maxFdv != null ? maxFdv / safeAdaPrice : null;
      }
      if (minFdvFilter != null && maxFdvFilter != null) {
        queryBuilder.andWhere('vault.fdv BETWEEN :minFdv AND :maxFdv', {
          minFdv: minFdvFilter,
          maxFdv: maxFdvFilter,
        });
      } else if (minFdvFilter != null) {
        queryBuilder.andWhere('vault.fdv >= :minFdv', { minFdv: minFdvFilter });
      } else if (maxFdvFilter != null) {
        queryBuilder.andWhere('vault.fdv <= :maxFdv', { maxFdv: maxFdvFilter });
      }
    }

    if (minTvl || maxTvl) {
      const tvlField = currency === Currency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';
      if (minTvl && maxTvl) {
        queryBuilder.andWhere(`${tvlField} BETWEEN :minTvl AND :maxTvl`, { minTvl, maxTvl });
      } else if (minTvl) {
        queryBuilder.andWhere(`${tvlField} >= :minTvl`, { minTvl });
      } else if (maxTvl) {
        queryBuilder.andWhere(`${tvlField} <= :maxTvl`, { maxTvl });
      }
    }

    if (minDelta || maxDelta) {
      if (minDelta && maxDelta) {
        queryBuilder.andWhere('vault.fdv_tvl BETWEEN :minDelta AND :maxDelta', { minDelta, maxDelta });
      } else if (minDelta) {
        queryBuilder.andWhere('vault.fdv_tvl >= :minDelta', { minDelta });
      } else if (maxDelta) {
        queryBuilder.andWhere('vault.fdv_tvl <= :maxDelta', { maxDelta });
      }
    }

    if (sortBy) {
      const sortField = this.mapSortField(sortBy);

      if (['ticker', 'price', 'tvl', 'fdv', 'supply'].includes(sortField)) {
        const tvlField = currency === Currency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';
        const vaultFieldMap: Record<string, string> = {
          ticker: 'vault.vault_token_ticker',
          price: 'vault.vt_price',
          tvl: tvlField,
          fdv: 'vault.fdv',
          supply: 'vault.ft_token_supply',
        };
        queryBuilder.orderBy(vaultFieldMap[sortField], sortOrder);
      } else {
        queryBuilder.orderBy(`market.${sortField}`, sortOrder);
      }
    } else {
      queryBuilder.orderBy('market.created_at', SortOrder.DESC);
    }

    queryBuilder.skip((page - 1) * limit).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    const mappedItems: MarketItem[] = items.map(item => this.mapMarketToItem(item, adaPrice));

    return {
      items: mappedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get market by vault ID
   * Note: The market is searched by vault_id since there is one market per vault
   * @param vaultId Vault ID to search for market
   * @returns Market data with vault information
   */
  async getMarketById(vaultId: string): Promise<MarketItem> {
    const rawItem = await this.getRawMarketByVaultId(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();
    return this.mapMarketToItem(rawItem, adaPrice);
  }

  /**
   * Get market data with OHLCV statistics
   * Combines market data from getMarketById with OHLCV data from Taptools API
   * Note: The id parameter is the vault_id since markets are searched by vault_id
   * @param vaultId Vault ID to search for market
   * @param interval OHLCV interval (default: '1h')
   * @returns Combined market data with OHLCV
   */
  async getMarketByIdWithOHLCV(vaultId: string, interval: string = '1h'): Promise<MarketItemWithOHLCV> {
    const rawMarket = await this.getRawMarketByVaultId(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();

    const baseMarketData = this.mapMarketToItem(rawMarket, adaPrice);

    const detailedMarketData = {
      ...baseMarketData,
      circSupply: rawMarket.circSupply,
      mcap: rawMarket.mcap,
      totalSupply: rawMarket.totalSupply,
    };

    const policyId = rawMarket.vault?.policy_id;
    const assetName = rawMarket.vault?.asset_vault_name;

    let ohlcvData = null;
    if (policyId && assetName) {
      ohlcvData = await this.vaultMarketStatsService.getTokenOHLCV(policyId, assetName, interval);
    } else {
      this.logger.warn(`Missing policy_id or asset_vault_name for vault ${vaultId}, skipping OHLCV`);
    }

    return {
      ...detailedMarketData,
      ohlcv: ohlcvData,
    };
  }

  private mapMarketToItem(item: Market, adaPrice: number = 0): MarketItem {
    const vault: Vault | null = item.vault || null;

    const vaultImage = vault?.vault_image ? transformImageToUrl(vault.vault_image as any) : null;
    const tokenImage = vault?.ft_token_img ? transformImageToUrl(vault.ft_token_img as any) : null;

    const priceAda = vault?.vt_price ?? null;
    const priceUsd = priceAda != null && adaPrice > 0 ? priceAda * adaPrice : null;
    const fdvAda = vault?.fdv ?? null;
    const fdvUsd = fdvAda != null ? fdvAda * adaPrice : null;
    const tvlAda = vault?.total_assets_cost_ada ?? null;
    const tvlUsd = vault?.total_assets_cost_usd ?? null;

    return {
      id: item.id,
      vault_id: item.vault_id,
      supply: vault?.ft_token_supply,
      price_change_1h: item.price_change_1h,
      price_change_24h: item.price_change_24h,
      price_change_7d: item.price_change_7d,
      price_change_30d: item.price_change_30d,
      delta: vault?.fdv_tvl ?? null,
      created_at: item.created_at,
      updated_at: item.updated_at,

      ticker: vault?.vault_token_ticker || null,
      price_ada: priceAda,
      price_usd: priceUsd,
      tvl_ada: tvlAda,
      tvl_usd: tvlUsd,
      fdv_ada: fdvAda,
      fdv_usd: fdvUsd,
      vault_image: vaultImage,
      token_image: tokenImage,
      social_links: vault?.social_links || [],
      tags: vault?.tags || [],
    };
  }

  private async getRawMarketByVaultId(vaultId: string): Promise<Market> {
    const queryBuilder = this.marketRepository.createQueryBuilder('market');

    queryBuilder
      .leftJoinAndSelect('market.vault', 'vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags')
      .where('market.vault_id = :vaultId', { vaultId });

    const item = await queryBuilder.getOne();

    if (!item) {
      throw new NotFoundException(`Market not found for vault ${vaultId}`);
    }

    return item;
  }

  private mapSortField(sortBy: MarketSortField): string {
    const fieldMap: Record<MarketSortField, string> = {
      [MarketSortField.fdv]: 'fdv',
      [MarketSortField.price]: 'price',
      [MarketSortField.ticker]: 'ticker',
      [MarketSortField.priceChange1h]: 'price_change_1h',
      [MarketSortField.priceChange24h]: 'price_change_24h',
      [MarketSortField.priceChange7d]: 'price_change_7d',
      [MarketSortField.priceChange30d]: 'price_change_30d',
      [MarketSortField.tvl]: 'tvl',
      [MarketSortField.delta]: 'delta',
      [MarketSortField.createdAt]: 'created_at',
      [MarketSortField.updatedAt]: 'updated_at',
      [MarketSortField.supply]: 'supply',
    };

    return fieldMap[sortBy] || 'created_at';
  }
}
