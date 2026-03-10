import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { transformImageToUrl } from '../../helpers';

import { GetMarketsResponse, MarketItem, MarketItemWithOHLCV } from './dto/get-markets-response.dto';
import { Currency, GetMarketsDto, MarketSortField, SortOrder } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';
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
    const { page = 1, limit = 10 } = query;
    const adaPrice = await this.priceService.getAdaPrice();

    const queryBuilder = this.createBaseQuery();

    this.applyVisibilityFilters(queryBuilder);
    this.applySearchAndRangeFilters(queryBuilder, query, adaPrice);
    this.applySorting(queryBuilder, query.sortBy, query.sortOrder, query.currency);

    queryBuilder.skip((page - 1) * limit).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items: items.map(item => this.mapMarketToItem(item, adaPrice)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getMarketById(vaultId: string): Promise<MarketItem> {
    const rawItem = await this.getRawMarketByVaultId(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();
    return this.mapMarketToItem(rawItem, adaPrice);
  }

  async getMarketByIdWithOHLCV(vaultId: string, interval: string = '1h'): Promise<MarketItemWithOHLCV> {
    const rawMarket = await this.getRawMarketByVaultId(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();
    const baseMarketData = this.mapMarketToItem(rawMarket, adaPrice);

    const { policy_id, asset_vault_name } = rawMarket.vault || {};
    let ohlcv = null;

    if (policy_id && asset_vault_name) {
      ohlcv = await this.vaultMarketStatsService.getTokenOHLCV(policy_id, asset_vault_name, interval);
    } else {
      this.logger.warn(`Missing policy_id or asset_vault_name for vault ${vaultId}, skipping OHLCV`);
    }

    return {
      ...baseMarketData,
      circSupply: rawMarket.circSupply,
      mcap: rawMarket.mcap,
      totalSupply: rawMarket.totalSupply,
      ohlcv,
    };
  }

  private createBaseQuery(): SelectQueryBuilder<Market> {
    return this.marketRepository
      .createQueryBuilder('market')
      .leftJoinAndSelect('market.vault', 'vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags');
  }

  private applyVisibilityFilters(queryBuilder: SelectQueryBuilder<Market>): void {
    if (this.isMainnet) {
      const hiddenIds = this.systemSettingsService.hiddenMainnetVaultIds;
      if (hiddenIds.length > 0) {
        queryBuilder.andWhere('market.vault_id NOT IN (:...hiddenIds)', { hiddenIds });
      }
    }
  }

  private applySearchAndRangeFilters(
    queryBuilder: SelectQueryBuilder<Market>,
    query: GetMarketsDto,
    adaPrice: number
  ): void {
    const { ticker, currency = Currency.ADA } = query;

    if (ticker) {
      queryBuilder.andWhere('vault.vault_token_ticker ILIKE :ticker', { ticker: `%${ticker}%` });
    }

    const priceDivider = currency === Currency.USD && adaPrice > 0 ? adaPrice : 1;
    const tvlField = currency === Currency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';

    this.addRangeCondition(queryBuilder, 'vault.vt_price', 'Price', query.minPrice, query.maxPrice, priceDivider);
    this.addRangeCondition(queryBuilder, 'vault.fdv', 'Fdv', query.minFdv, query.maxFdv, priceDivider);
    this.addRangeCondition(queryBuilder, tvlField, 'Tvl', query.minTvl, query.maxTvl);
    this.addRangeCondition(queryBuilder, 'vault.fdv_tvl', 'Delta', query.minDelta, query.maxDelta, priceDivider);
    this.addRangeCondition(
      queryBuilder,
      'market.fdv_per_asset',
      'FdvPerAsset',
      query.minFdvPerAsset,
      query.maxFdvPerAsset
    );
  }

  private addRangeCondition(
    queryBuilder: SelectQueryBuilder<Market>,
    dbField: string,
    paramName: string,
    min?: number,
    max?: number,
    divider: number = 1
  ): void {
    const minVal = min != null ? min / divider : null;
    const maxVal = max != null ? max / divider : null;

    if (minVal != null && maxVal != null) {
      queryBuilder.andWhere(`${dbField} BETWEEN :min${paramName} AND :max${paramName}`, {
        [`min${paramName}`]: minVal,
        [`max${paramName}`]: maxVal,
      });
    } else if (minVal != null) {
      queryBuilder.andWhere(`${dbField} >= :min${paramName}`, { [`min${paramName}`]: minVal });
    } else if (maxVal != null) {
      queryBuilder.andWhere(`${dbField} <= :max${paramName}`, { [`max${paramName}`]: maxVal });
    }
  }

  private applySorting(
    queryBuilder: SelectQueryBuilder<Market>,
    sortBy?: MarketSortField,
    sortOrder: SortOrder = SortOrder.DESC,
    currency: Currency = Currency.ADA
  ): void {
    if (!sortBy) {
      queryBuilder.orderBy('market.created_at', sortOrder);
      return;
    }

    const tvlField = currency === Currency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';

    const sortFieldMap: Record<MarketSortField, string> = {
      [MarketSortField.ticker]: 'vault.vault_token_ticker',
      [MarketSortField.price]: 'vault.vt_price',
      [MarketSortField.tvl]: tvlField,
      [MarketSortField.fdv]: 'vault.fdv',
      [MarketSortField.supply]: 'vault.ft_token_supply',
      [MarketSortField.fdvPerAsset]: 'market.fdv_per_asset',
      [MarketSortField.priceChange1h]: 'market.price_change_1h',
      [MarketSortField.priceChange24h]: 'market.price_change_24h',
      [MarketSortField.priceChange7d]: 'market.price_change_7d',
      [MarketSortField.priceChange30d]: 'market.price_change_30d',
      [MarketSortField.delta]: 'vault.fdv_tvl',
      [MarketSortField.createdAt]: 'market.created_at',
      [MarketSortField.updatedAt]: 'market.updated_at',
    };

    const dbField = sortFieldMap[sortBy] || 'market.created_at';
    queryBuilder.orderBy(dbField, sortOrder);
  }

  private async getRawMarketByVaultId(vaultId: string): Promise<Market> {
    const item = await this.createBaseQuery().where('market.vault_id = :vaultId', { vaultId }).getOne();

    if (!item) {
      throw new NotFoundException(`Market not found for vault ${vaultId}`);
    }

    return item;
  }

  private mapMarketToItem(item: Market, adaPrice: number = 0): MarketItem {
    const vault = item.vault;
    const hasAdaPrice = adaPrice > 0;

    const priceAda = vault?.vt_price ?? null;
    const fdvAda = vault?.fdv ?? null;
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
      fdv_per_asset: item.fdv_per_asset,
      created_at: item.created_at,
      updated_at: item.updated_at,

      ticker: vault?.vault_token_ticker || null,
      price_ada: priceAda,
      price_usd: priceAda != null && hasAdaPrice ? priceAda * adaPrice : null,
      tvl_ada: tvlAda,
      tvl_usd: tvlUsd,
      fdv_ada: fdvAda,
      fdv_usd: fdvAda != null && hasAdaPrice ? fdvAda * adaPrice : null,

      vault_image: vault?.vault_image ? transformImageToUrl(vault.vault_image as any) : null,
      token_image: vault?.ft_token_img ? transformImageToUrl(vault.ft_token_img as any) : null,
      social_links: vault?.social_links || [],
      tags: vault?.tags || [],
    };
  }
}
