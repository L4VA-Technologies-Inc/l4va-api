import { MarketOhlcvSeries } from './market-ohlcv.dto';

import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';

export interface MarketItem {
  id: string;
  vault_id: string;
  supply?: number;
  circSupply?: number;
  mcap?: number;
  totalSupply?: number;
  price_change_1h: number;
  price_change_24h: number;
  price_change_7d: number;
  price_change_30d: number;
  delta: number | null;
  fdv_per_asset: number | null;
  created_at: Date;
  updated_at: Date;
  ticker: string | null;
  price_ada: number | null;
  price_usd: number | null;
  fdv_ada: number | null;
  fdv_usd: number | null;
  tvl_ada: number | null;
  tvl_usd: number | null;
  vault_image: string | null;
  token_image: string | null;
  social_links: LinkEntity[];
  tags: TagEntity[];
}

export interface GetMarketsResponse {
  items: MarketItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Minimal market data shape used on the frontend vault metrics view.
 * Keeps the payload small by exposing only the fields that are actually consumed there.
 */
export interface MarketItemWithOHLCV {
  id: string;
  vault_id: string;
  supply?: number;
  mcap?: number;

  price_change_24h: number;
  price_change_7d: number;
  price_change_30d: number;

  price_ada: number | null;
  price_usd: number | null;
  fdv_ada: number | null;
  fdv_usd: number | null;
  tvl_ada: number | null;
  tvl_usd: number | null;
  fdv_tvl: number | null;

  adaPrice: number;
  ohlcv: MarketOhlcvSeries | null;
}
