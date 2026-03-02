import { MarketOhlcvSeries } from './market-ohlcv.dto';

import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';

export interface MarketItem {
  id: string;
  vault_id: string;
  circSupply: number;
  mcap: number;
  totalSupply: number;
  price_change_1h: number;
  price_change_24h: number;
  price_change_7d: number;
  price_change_30d: number;
  delta: number | null;
  created_at: Date;
  updated_at: Date;
  ticker: string | null;
  price: number | null;
  tvl_ada: number | null;
  tvl_usd: number | null;
  fdv: number | null;
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

export interface MarketItemWithOHLCV extends MarketItem {
  ohlcv: MarketOhlcvSeries | null;
}
