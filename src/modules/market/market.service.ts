import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GetMarketsDto, MarketSortField, SortOrder } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>
  ) {}

  async getMarkets(query: GetMarketsDto): Promise<{
    items: Market[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const {
      page = 1,
      limit = 10,
      sortBy,
      sortOrder = SortOrder.DESC,
      ticker,
      unit,
      minPrice,
      maxPrice,
      minMcap,
      maxMcap,
      minTvl,
      maxTvl,
    } = query;

    const queryBuilder = this.marketRepository.createQueryBuilder('market');

    if (ticker) {
      queryBuilder.andWhere('market.ticker ILIKE :ticker', {
        ticker: `%${ticker}%`,
      });
    }

    if (unit) {
      queryBuilder.andWhere('market.unit = :unit', { unit });
    }

    if (minPrice || maxPrice) {
      if (minPrice && maxPrice) {
        queryBuilder.andWhere('market.price BETWEEN :minPrice AND :maxPrice', { minPrice, maxPrice });
      } else if (minPrice) {
        queryBuilder.andWhere('market.price >= :minPrice', { minPrice });
      } else if (maxPrice) {
        queryBuilder.andWhere('market.price <= :maxPrice', { maxPrice });
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
        queryBuilder.andWhere('market.tvl BETWEEN :minTvl AND :maxTvl', { minTvl, maxTvl });
      } else if (minTvl) {
        queryBuilder.andWhere('market.tvl >= :minTvl', { minTvl });
      } else if (maxTvl) {
        queryBuilder.andWhere('market.tvl <= :maxTvl', { maxTvl });
      }
    }

    if (sortBy) {
      const sortField = this.mapSortField(sortBy);
      if (['1h', '24h', '7d', '30d'].includes(sortField)) {
        queryBuilder.orderBy(`market."${sortField}"`, sortOrder);
      } else {
        queryBuilder.orderBy(`market.${sortField}`, sortOrder);
      }
    } else {
      queryBuilder.orderBy('market.created_at', SortOrder.DESC);
    }

    queryBuilder.skip((page - 1) * limit).take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private mapSortField(sortBy: MarketSortField): string {
    const fieldMap: Record<MarketSortField, string> = {
      [MarketSortField.unit]: 'unit',
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
