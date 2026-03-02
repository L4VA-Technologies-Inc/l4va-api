import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';

import { GetMarketsResponse, MarketItem, MarketItemWithOHLCV } from './dto/get-markets-response.dto';
import { GetMarketsDto, MarketSortField, SortOrder, TvlCurrency } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
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
      minMcap,
      maxMcap,
      minTvl,
      maxTvl,
      minDelta,
      maxDelta,
      tvlCurrency = TvlCurrency.ADA,
    } = query;

    const queryBuilder = this.marketRepository.createQueryBuilder('market');

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

    if (minPrice || maxPrice) {
      if (minPrice && maxPrice) {
        queryBuilder.andWhere('vault.vt_price BETWEEN :minPrice AND :maxPrice', { minPrice, maxPrice });
      } else if (minPrice) {
        queryBuilder.andWhere('vault.vt_price >= :minPrice', { minPrice });
      } else if (maxPrice) {
        queryBuilder.andWhere('vault.vt_price <= :maxPrice', { maxPrice });
      }
    }

    if (minMcap || maxMcap) {
      if (minMcap && maxMcap) {
        queryBuilder.andWhere('market.mcap BETWEEN :minMcap AND :maxMcap', { minMcap, maxMcap });
      } else if (minMcap) {
        queryBuilder.andWhere('market.mcap >= :minMcap', { minMcap });
      } else if (maxMcap) {
        queryBuilder.andWhere('market.mcap <= :maxMcap', { maxMcap });
      }
    }

    if (minTvl || maxTvl) {
      const tvlField = tvlCurrency === TvlCurrency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';
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
        queryBuilder.andWhere('market.delta BETWEEN :minDelta AND :maxDelta', { minDelta, maxDelta });
      } else if (minDelta) {
        queryBuilder.andWhere('market.delta >= :minDelta', { minDelta });
      } else if (maxDelta) {
        queryBuilder.andWhere('market.delta <= :maxDelta', { maxDelta });
      }
    }

    if (sortBy) {
      const sortField = this.mapSortField(sortBy);

      if (['ticker', 'price', 'tvl', 'fdv'].includes(sortField)) {
        const tvlField =
          tvlCurrency === TvlCurrency.USD ? 'vault.total_assets_cost_usd' : 'vault.total_assets_cost_ada';
        const vaultFieldMap: Record<string, string> = {
          ticker: 'vault.vault_token_ticker',
          price: 'vault.vt_price',
          tvl: tvlField,
          fdv: 'vault.fdv',
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

    const mappedItems: MarketItem[] = items.map(item => this.mapMarketToItem(item));

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
    return this.mapMarketToItem(rawItem);
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

    const policyId = rawMarket.vault?.policy_id;
    const assetName = rawMarket.vault?.asset_vault_name;

    const marketData = this.mapMarketToItem(rawMarket);

    let ohlcvData = null;
    if (policyId && assetName) {
      ohlcvData = await this.vaultMarketStatsService.getTokenOHLCV(policyId, assetName, interval);
    } else {
      this.logger.warn(`Missing policy_id or asset_vault_name for vault ${vaultId}, skipping OHLCV`);
    }

    return {
      ...marketData,
      ohlcv: ohlcvData,
    };
  }

  private mapMarketToItem(item: Market): MarketItem {
    const vault: Vault | null = item.vault || null;

    const vaultImage = vault?.vault_image ? transformImageToUrl(vault.vault_image as any) : null;
    const tokenImage = vault?.ft_token_img ? transformImageToUrl(vault.ft_token_img as any) : null;

    return {
      id: item.id,
      vault_id: item.vault_id,
      circSupply: item.circSupply,
      mcap: item.mcap,
      totalSupply: item.totalSupply,
      price_change_1h: item.price_change_1h,
      price_change_24h: item.price_change_24h,
      price_change_7d: item.price_change_7d,
      price_change_30d: item.price_change_30d,
      delta: item.delta,
      created_at: item.created_at,
      updated_at: item.updated_at,

      ticker: vault?.vault_token_ticker || null,
      price: vault?.vt_price || null,
      tvl_ada: vault?.total_assets_cost_ada || null,
      tvl_usd: vault?.total_assets_cost_usd || null,
      fdv: vault?.fdv || null,
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
      [MarketSortField.circSupply]: 'circSupply',
      [MarketSortField.fdv]: 'fdv',
      [MarketSortField.mcap]: 'mcap',
      [MarketSortField.price]: 'price',
      [MarketSortField.ticker]: 'ticker',
      [MarketSortField.totalSupply]: 'totalSupply',
      [MarketSortField.priceChange1h]: 'price_change_1h',
      [MarketSortField.priceChange24h]: 'price_change_24h',
      [MarketSortField.priceChange7d]: 'price_change_7d',
      [MarketSortField.priceChange30d]: 'price_change_30d',
      [MarketSortField.tvl]: 'tvl',
      [MarketSortField.delta]: 'delta',
      [MarketSortField.createdAt]: 'created_at',
      [MarketSortField.updatedAt]: 'updated_at',
    };

    return fieldMap[sortBy] || 'created_at';
  }
}
