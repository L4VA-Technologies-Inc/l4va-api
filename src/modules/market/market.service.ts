import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';

import { transformImageToUrl } from '../../helpers';

import { GetMarketsResponse, MarketItem, MarketItemWithOHLCV } from './dto/get-markets-response.dto';
import { MarketOhlcvSeries } from './dto/market-ohlcv.dto';
import { Currency, GetMarketsDto, MarketSortField, SortOrder } from './dto/get-markets.dto';

import { Market } from '@/database/market.entity';
import { Vault } from '@/database/vault.entity';
import { DexHunterPricingClient } from '@/modules/dexhunter/dexhunter-pricing.client';
import { SystemSettingsService } from '@/modules/globals/system-settings/system-settings.service';
import { PriceService } from '@/modules/price/price.service';
import { TapToolsClient } from '@/modules/taptools/taptools.client';
import { MarketType } from '@/types/market.types';
import { ChainType, VAULT_STATUSES_WITH_VT_TOKENS } from '@/types/vault.types';

@Injectable()
export class MarketService implements OnModuleInit {
  private readonly logger = new Logger(MarketService.name);
  private isMainnet: boolean;

  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly priceService: PriceService,
    private readonly tapToolsClient: TapToolsClient,
    private readonly dexHunterClient: DexHunterPricingClient
  ) {}

  onModuleInit(): void {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /** Vault tokens for the public Tokens table. Mainnet requires a DEX LP; testnet uses our NAV. */
  async listVaultLpTokens(chainType: ChainType) {
    const [adaPrice, ethPrice] = await Promise.all([this.priceService.getAdaPrice(), this.priceService.getEthPrice()]);

    if (!this.isMainnet) {
      return this.listTestnetVaultTokens(chainType, adaPrice, ethPrice);
    }

    const queryBuilder = this.createBaseQuery()
      .andWhere('market.type = :type', { type: MarketType.vault_token })
      .andWhere('vault.has_active_lp = true')
      .andWhere('vault.chain_type = :chainType', { chainType });

    const hiddenIds = this.systemSettingsService.hiddenMainnetVaultIds;
    if (hiddenIds.length > 0) {
      queryBuilder.andWhere('market.vault_id NOT IN (:...hiddenIds)', { hiddenIds });
    }

    const items = await queryBuilder.getMany();
    return items.map(item => this.mapVaultMarketToTokenRow(item, adaPrice, ethPrice));
  }

  /** Preprod has no DexHunter/TapTools index for VT — list locked vaults with NAV from our TVL. */
  private async listTestnetVaultTokens(chainType: ChainType, adaPrice: number, ethPrice: number) {
    const vaults = await this.vaultRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags')
      .where('vault.chain_type = :chainType', { chainType })
      .andWhere('vault.vault_status IN (:...statuses)', { statuses: VAULT_STATUSES_WITH_VT_TOKENS })
      .andWhere('(vault.vault_token_ticker IS NOT NULL OR vault.script_hash IS NOT NULL)')
      .getMany();

    if (vaults.length === 0) return [];

    const markets = await this.marketRepository.find({
      where: { vault_id: In(vaults.map(vault => vault.id)) },
    });
    const marketByVaultId = new Map(markets.map(market => [market.vault_id, market]));

    return vaults.map(vault => {
      const existing = marketByVaultId.get(vault.id);
      const item = existing
        ? Object.assign(existing, { vault })
        : this.marketRepository.create({
            id: vault.id,
            vault_id: vault.id,
            type: MarketType.vault_token,
            vault,
          });
      return this.mapVaultMarketToTokenRow(item, adaPrice, ethPrice);
    });
  }

  /** Single vault token in the same shape as the Tokens table, including swap/copy identity. */
  async getVaultTokenById(id: string) {
    const rawItem = await this.getRawMarketByVaultIdWithRelations(id);
    const [adaPrice, ethPrice] = await Promise.all([this.priceService.getAdaPrice(), this.priceService.getEthPrice()]);
    return this.mapVaultMarketToTokenRow(rawItem, adaPrice, ethPrice);
  }

  async getMarkets(query: GetMarketsDto): Promise<GetMarketsResponse> {
    const { page = 1, limit = 10 } = query;
    const adaPrice = await this.priceService.getAdaPrice();
    const ethPrice = await this.priceService.getEthPrice();

    const queryBuilder = this.createBaseQuery();

    this.applyVisibilityFilters(queryBuilder, query.type);
    this.applySearchAndRangeFilters(queryBuilder, query, adaPrice, ethPrice);
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
    const rawItem = await this.getRawMarketByVaultIdWithRelations(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();
    return this.mapMarketToItem(rawItem, adaPrice);
  }

  async getMarketByIdWithOHLCV(vaultId: string, interval: string = '1h'): Promise<MarketItemWithOHLCV> {
    const rawMarket = await this.getRawMarketByVaultId(vaultId);
    const adaPrice = await this.priceService.getAdaPrice();
    const baseMarketData = this.mapMarketToItem(rawMarket, adaPrice);

    const vaultScriptHash = rawMarket.vault?.script_hash;
    const vaultAssetName = rawMarket.vault?.asset_vault_name;
    const hasDexIdentity = Boolean(vaultScriptHash && vaultAssetName);
    const shouldFetchDex = this.isMainnet && Boolean(rawMarket.vault?.has_active_lp) && hasDexIdentity;
    let ohlcv = null;

    if (shouldFetchDex) {
      ohlcv = await this.tapToolsClient.getTokenOHLCV(vaultScriptHash, vaultAssetName, interval);

      if (!ohlcv) {
        ohlcv = await this.dexHunterClient.getTokenOHLCV(vaultScriptHash, vaultAssetName, interval);

        if (ohlcv) {
          this.logger.log(`DexHunter OHLCV fallback successful for vault ${vaultId}`);
        } else {
          this.logger.warn(`Both TapTools and DexHunter OHLCV unavailable for vault ${vaultId}`);
        }
      }
    } else if (hasDexIdentity && !shouldFetchDex) {
      this.logger.debug(`Skipping DEX OHLCV for vault ${vaultId} (testnet or no active LP)`);
    }
    const {
      id,
      vault_id,
      type,
      name,
      ticker,
      token_image,
      chain_type,
      contract_address,
      script_hash,
      asset_vault_name,
      supply,
      price_change_24h,
      price_change_7d,
      price_change_30d,
      price_ada,
      price_usd,
      tvl_ada,
      tvl_usd,
      fdv_ada,
      fdv_usd,
      delta,
    } = baseMarketData;

    const vault = rawMarket.vault;
    const supplyValue = supply != null ? Number(supply) : vault?.ft_token_supply != null ? Number(vault.ft_token_supply) : null;
    const derivedPriceAda = this.deriveNavPriceAda(
      price_ada != null ? Number(price_ada) : null,
      fdv_ada,
      tvl_ada,
      supplyValue
    );

    if ((!ohlcv || ohlcv.length === 0) && derivedPriceAda && derivedPriceAda > 0) {
      ohlcv = this.buildFallbackOhlcv(derivedPriceAda, interval, vault?.locked_at || vault?.created_at);
    }

    const resolvedPriceAda = derivedPriceAda ?? price_ada;
    const resolvedPriceUsd =
      resolvedPriceAda != null && adaPrice > 0 ? resolvedPriceAda * adaPrice : price_usd;

    return {
      id,
      vault_id,
      type,
      name,
      ticker,
      token_image,
      chain_type,
      contract_address,
      script_hash,
      asset_vault_name,
      supply,
      mcap: rawMarket.mcap,
      price_change_24h,
      price_change_7d,
      price_change_30d,
      price_ada: resolvedPriceAda,
      price_usd: resolvedPriceUsd,
      tvl_ada,
      tvl_usd,
      fdv_ada,
      fdv_usd,
      adaPrice,
      fdv_tvl: delta,
      ohlcv: ohlcv || [],
    };
  }

  /** Flat NAV series used when DexHunter/TapTools have no candles (typical on preprod). */
  private buildFallbackOhlcv(priceAda: number, interval: string, createdAt?: Date): MarketOhlcvSeries {
    const now = Math.floor(Date.now() / 1000);
    const stepByInterval: Record<string, number> = {
      '1h': 3600,
      '1d': 86400,
      '1w': 86400 * 7,
    };
    const countByInterval: Record<string, number> = {
      '1h': 48,
      '1d': 90,
      '1w': 52,
    };
    const step = stepByInterval[interval] || 86400;
    const count = countByInterval[interval] || 30;
    const end = Math.floor(now / step) * step;
    const created = createdAt ? Math.floor(new Date(createdAt).getTime() / 1000) : NaN;
    const earliest = Number.isFinite(created) ? created : end - count * step;
    let start = Math.max(earliest, end - (count - 1) * step);
    start = Math.floor(start / step) * step;
    const points: MarketOhlcvSeries = [];

    for (let time = start; time <= end; time += step) {
      points.push({
        time,
        open: priceAda,
        high: priceAda,
        low: priceAda,
        close: priceAda,
        volume: 0,
      });
    }

    if (points.length === 0) {
      points.push({ time: end || now, open: priceAda, high: priceAda, low: priceAda, close: priceAda, volume: 0 });
    }

    return points;
  }

  private toFiniteNumber(value: unknown): number | null {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private deriveNavPriceAda(priceAda: number | null, fdvAda: unknown, tvlAda: unknown, supply: unknown): number | null {
    if (priceAda != null && priceAda > 0) return priceAda;
    const supplyNum = this.toFiniteNumber(supply);
    if (!(supplyNum && supplyNum > 0)) return priceAda;
    const fdv = this.toFiniteNumber(fdvAda);
    if (fdv && fdv > 0) return fdv / supplyNum;
    const tvl = this.toFiniteNumber(tvlAda);
    if (tvl && tvl > 0) return tvl / supplyNum;
    return priceAda;
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

  private applyVisibilityFilters(queryBuilder: SelectQueryBuilder<Market>, type?: MarketType): void {
    if (type === MarketType.robinhood_token) {
      queryBuilder.andWhere('market.type = :type', { type });
    } else {
      queryBuilder.andWhere('vault.has_active_lp = true');
      if (type) {
        queryBuilder.andWhere('market.type = :type', { type });
      }
    }

    if (this.isMainnet) {
      const hiddenIds = this.systemSettingsService.hiddenMainnetVaultIds;
      if (hiddenIds.length > 0) {
        queryBuilder.andWhere('(market.vault_id IS NULL OR market.vault_id NOT IN (:...hiddenIds))', { hiddenIds });
      }
    }
  }

  private applySearchAndRangeFilters(
    queryBuilder: SelectQueryBuilder<Market>,
    query: GetMarketsDto,
    adaPrice: number,
    ethPrice: number
  ): void {
    const { ticker, currency = Currency.ADA } = query;

    if (ticker) {
      queryBuilder.andWhere('(vault.vault_token_ticker ILIKE :ticker OR market.symbol ILIKE :ticker)', {
        ticker: `%${ticker}%`,
      });
    }

    // Price columns (vt_price, fdv, fdv_per_asset) are stored in ADA.
    // priceDivider converts the requested-currency input back to ADA.
    // tvlDivider converts the requested-currency TVL input to the tvlField's currency.
    let priceDivider = 1;
    let tvlField = 'vault.total_assets_cost_ada';
    const tvlDivider = 1;

    switch (currency) {
      case Currency.USD:
        priceDivider = adaPrice > 0 ? adaPrice : 1;
        tvlField = 'vault.total_assets_cost_usd';
        break;
      case Currency.ETH:
        // Price columns are ADA-denominated with no ETH column; convert ETH input back to ADA.
        priceDivider = ethPrice > 0 && adaPrice > 0 ? adaPrice / ethPrice : 1;
        // TVL has a dedicated ETH column, so the input is compared directly.
        tvlField = 'vault.total_assets_cost_eth';
        break;
      case Currency.ADA:
      default:
        // Defaults already set: priceDivider = 1, tvlField = ADA column.
        break;
    }

    this.addRangeCondition(queryBuilder, 'vault.vt_price', 'Price', query.minPrice, query.maxPrice, priceDivider);
    this.addRangeCondition(queryBuilder, 'vault.fdv', 'Fdv', query.minFdv, query.maxFdv, priceDivider);
    this.addRangeCondition(queryBuilder, tvlField, 'Tvl', query.minTvl, query.maxTvl, tvlDivider);
    this.addRangeCondition(queryBuilder, 'vault.fdv_tvl', 'Delta', query.minDelta, query.maxDelta);
    this.addRangeCondition(
      queryBuilder,
      'market.fdv_per_asset',
      'FdvPerAsset',
      query.minFdvPerAsset,
      query.maxFdvPerAsset,
      priceDivider
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
      [MarketSortField.ticker]: 'COALESCE(vault.vault_token_ticker, market.symbol)',
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

  /** Minimal load: only market + vault. Use for OHLCV endpoint where relations are not needed. */
  private async getRawMarketByVaultId(vaultId: string): Promise<Market> {
    return this.findRawMarket(vaultId, false);
  }

  /** Full load: vault + social_links, vault_image, ft_token_img, tags. Use for getMarketById. */
  private async getRawMarketByVaultIdWithRelations(vaultId: string): Promise<Market> {
    return this.findRawMarket(vaultId, true);
  }

  private async findRawMarket(id: string, withRelations: boolean): Promise<Market> {
    const queryBuilder = withRelations
      ? this.createBaseQuery()
      : this.marketRepository.createQueryBuilder('market').leftJoinAndSelect('market.vault', 'vault');

    // `id` is bound as uuid for market.id / vault_id. A second text param is required for LOWER(),
    // otherwise Postgres infers uuid and throws `function lower(uuid) does not exist` (HTTP 500).
    const item = await queryBuilder
      .where(
        '(market.vault_id = :id OR market.id = :id OR LOWER(COALESCE(market.contract_address, \'\')) = LOWER(:contractId))',
        { id, contractId: id }
      )
      .getOne();

    if (item) {
      return item;
    }

    const vaultQuery = withRelations
      ? this.vaultRepository
          .createQueryBuilder('vault')
          .leftJoinAndSelect('vault.social_links', 'social_links')
          .leftJoinAndSelect('vault.vault_image', 'vault_image')
          .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
          .leftJoinAndSelect('vault.tags', 'tags')
      : this.vaultRepository.createQueryBuilder('vault');

    const vault = await vaultQuery.where('vault.id = :id', { id }).getOne();
    if (!vault) {
      throw new NotFoundException(`Market not found for ${id}`);
    }

    return this.marketRepository.create({
      id: vault.id,
      vault_id: vault.id,
      type: MarketType.vault_token,
      vault,
    });
  }

  private mapVaultMarketToTokenRow(item: Market, adaPrice: number, ethPrice: number) {
    const mapped = this.mapMarketToItem(item, adaPrice);
    const priceUsd = mapped.price_usd;
    const fdvUsd = mapped.fdv_usd;
    const mcapAda = item.mcap != null ? Number(item.mcap) : null;
    const mcapUsd = mcapAda != null && adaPrice > 0 ? mcapAda * adaPrice : fdvUsd;
    const liqAda = item.totalAdaLiquidity != null ? Number(item.totalAdaLiquidity) : mapped.tvl_ada;
    const liqUsd = liqAda != null && adaPrice > 0 ? liqAda * adaPrice : mapped.tvl_usd;
    const priceEth = priceUsd != null && ethPrice > 0 ? priceUsd / ethPrice : null;
    const fdvEth = fdvUsd != null && ethPrice > 0 ? fdvUsd / ethPrice : null;
    const mcapEth = mcapUsd != null && ethPrice > 0 ? mcapUsd / ethPrice : null;
    const liqEth = liqUsd != null && ethPrice > 0 ? liqUsd / ethPrice : null;

    return {
      id: mapped.vault_id,
      vault_id: mapped.vault_id,
      symbol: mapped.ticker,
      name: mapped.name || mapped.ticker,
      image: mapped.token_image || mapped.vault_image,
      price_usd: priceUsd,
      price_ada: mapped.price_ada,
      price_eth: priceEth,
      market_cap: mcapUsd,
      market_cap_ada: mcapAda ?? mapped.fdv_ada,
      market_cap_eth: mcapEth,
      fdv: fdvUsd,
      fdv_ada: mapped.fdv_ada,
      fdv_eth: fdvEth,
      volume_24h: null,
      volume_24h_ada: null,
      volume_24h_eth: null,
      liquidity_usd: liqUsd,
      liquidity_ada: liqAda,
      liquidity_eth: liqEth,
      change_24h: mapped.price_change_24h,
      high_24h: null,
      high_24h_ada: null,
      high_24h_eth: null,
      low_24h: null,
      low_24h_ada: null,
      low_24h_eth: null,
      sparkline: [] as number[],
      source: 'vault' as const,
      asset_class: 'vault_token' as const,
      chain_type: mapped.chain_type,
      contract_address: mapped.contract_address,
      script_hash: mapped.script_hash ?? null,
      asset_vault_name: mapped.asset_vault_name ?? null,
      has_active_lp: Boolean(item.vault?.has_active_lp),
    };
  }

  private mapMarketToItem(item: Market, adaPrice: number = 0): MarketItem {
    const vault = item.vault;
    const hasAdaPrice = adaPrice > 0;

    const standalonePriceUsd = item.price_usd != null ? Number(item.price_usd) : null;
    const standaloneFdvUsd = item.fdv != null ? Number(item.fdv) : null;
    const listedPriceAda =
      vault?.vt_price != null && Number(vault.vt_price) > 0
        ? Number(vault.vt_price)
        : standalonePriceUsd != null && hasAdaPrice
          ? standalonePriceUsd / adaPrice
          : null;
    const fdvAda = vault?.fdv ?? (standaloneFdvUsd != null && hasAdaPrice ? standaloneFdvUsd / adaPrice : null);
    const tvlAda = vault?.total_assets_cost_ada ?? null;
    const tvlUsd = vault?.total_assets_cost_usd ?? (item.liquidity_usd != null ? Number(item.liquidity_usd) : null);
    const supply = vault?.ft_token_supply ?? (item.totalSupply != null ? Number(item.totalSupply) : undefined);
    const priceAda = this.deriveNavPriceAda(listedPriceAda, fdvAda, tvlAda, supply);
    const fdvPerAssetAda = item.fdv_per_asset ?? null;

    const ticker = vault?.vault_token_ticker || item.symbol || null;
    const tokenImage = vault?.ft_token_img ? transformImageToUrl(vault.ft_token_img as any) : item.image_url || null;
    const mappedPriceUsd = priceAda != null && hasAdaPrice ? priceAda * adaPrice : standalonePriceUsd;
    const mappedFdvUsd = fdvAda != null && hasAdaPrice ? fdvAda * adaPrice : standaloneFdvUsd;

    return {
      id: item.id,
      vault_id: item.vault_id,
      type: item.type,
      token_kind: item.token_kind,
      name: item.name || vault?.name || null,
      contract_address: item.contract_address || vault?.contract_address || null,
      supply,
      price_change_1h: item.price_change_1h,
      price_change_24h: item.price_change_24h,
      price_change_7d: item.price_change_7d,
      price_change_30d: item.price_change_30d,
      delta: vault?.fdv_tvl ?? item.delta ?? null,
      fdv_per_asset_ada: fdvPerAssetAda,
      fdv_per_asset_usd: fdvPerAssetAda != null && hasAdaPrice ? fdvPerAssetAda * adaPrice : null,
      created_at: item.created_at,
      updated_at: item.updated_at,

      ticker,
      price_ada: priceAda,
      price_usd: mappedPriceUsd,
      tvl_ada: tvlAda,
      tvl_usd: tvlUsd,
      fdv_ada: fdvAda,
      fdv_usd: mappedFdvUsd,
      chain_type: vault?.chain_type ?? null,
      script_hash: vault?.script_hash ?? null,
      asset_vault_name: vault?.asset_vault_name ?? null,

      vault_image: vault?.vault_image ? transformImageToUrl(vault.vault_image as any) : item.image_url || null,
      token_image: tokenImage,
      social_links: vault?.social_links || [],
      tags: vault?.tags || [],
    };
  }
}
