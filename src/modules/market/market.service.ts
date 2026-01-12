import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { transformImageToUrl } from '../../helpers';

import { GetMarketsResponse, MarketItem } from './dto/get-markets-response.dto';
import { GetMarketsDto, MarketSortField, SortOrder } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>
  ) {}

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
    } = query;

    const queryBuilder = this.marketRepository.createQueryBuilder('market');

    queryBuilder
      .leftJoinAndSelect('market.vault', 'vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags');

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
      if (minTvl && maxTvl) {
        queryBuilder.andWhere('vault.total_assets_cost_ada BETWEEN :minTvl AND :maxTvl', { minTvl, maxTvl });
      } else if (minTvl) {
        queryBuilder.andWhere('vault.total_assets_cost_ada >= :minTvl', { minTvl });
      } else if (maxTvl) {
        queryBuilder.andWhere('vault.total_assets_cost_ada <= :maxTvl', { maxTvl });
      }
    }

    if (sortBy) {
      const sortField = this.mapSortField(sortBy);

      if (['ticker', 'price', 'tvl', 'fdv'].includes(sortField)) {
        const vaultFieldMap: Record<string, string> = {
          ticker: 'vault.vault_token_ticker',
          price: 'vault.vt_price',
          tvl: 'vault.total_assets_cost_ada',
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

    const mappedItems: MarketItem[] = items.map(item => {
      const vault: Vault | null = item.vault || null;

      const vaultImage = vault?.vault_image ? transformImageToUrl(vault.vault_image as any) : null;
      const tokenImage = vault?.ft_token_img ? transformImageToUrl(vault.ft_token_img as any) : null;

      return {
        id: item.id,
        vault_id: item.vault_id,
        circSupply: item.circSupply,
        mcap: item.mcap,
        totalSupply: item.totalSupply,
        '1h': item['1h'],
        '24h': item['24h'],
        '7d': item['7d'],
        '30d': item['30d'],
        created_at: item.created_at,
        updated_at: item.updated_at,

        ticker: vault?.vault_token_ticker || null,
        price: vault?.vt_price || null,
        tvl: vault?.total_assets_cost_ada || null,
        fdv: vault?.fdv || null,
        vault_image: vaultImage,
        token_image: tokenImage,
        social_links: vault?.social_links || [],
        tags: vault?.tags || [],
      };
    });

    return {
      items: mappedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async upsertMarketData(data: {
    vault_id: string;
    circSupply: number;
    mcap: number;
    totalSupply: number;
    '1h': number;
    '24h': number;
    '7d': number;
    '30d': number;
  }): Promise<Market> {
    const existingMarket = await this.marketRepository.findOne({
      where: { vault_id: data.vault_id },
    });

    if (existingMarket) {
      Object.assign(existingMarket, {
        ...data,
        vault_id: data.vault_id,
      });
      return await this.marketRepository.save(existingMarket);
    } else {
      const newMarket = this.marketRepository.create({
        ...data,
        vault_id: data.vault_id,
      });
      return await this.marketRepository.save(newMarket);
    }
  }

  private mapSortField(sortBy: MarketSortField): string {
    const fieldMap: Record<MarketSortField, string> = {
      [MarketSortField.circSupply]: 'circSupply',
      [MarketSortField.fdv]: 'fdv',
      [MarketSortField.mcap]: 'mcap',
      [MarketSortField.price]: 'price',
      [MarketSortField.ticker]: 'ticker',
      [MarketSortField.totalSupply]: 'totalSupply',
      [MarketSortField.priceChange1h]: '1h',
      [MarketSortField.priceChange24h]: '24h',
      [MarketSortField.priceChange7d]: '7d',
      [MarketSortField.priceChange30d]: '30d',
      [MarketSortField.tvl]: 'tvl',
      [MarketSortField.createdAt]: 'created_at',
      [MarketSortField.updatedAt]: 'updated_at',
    };

    return fieldMap[sortBy] || 'created_at';
  }
}
