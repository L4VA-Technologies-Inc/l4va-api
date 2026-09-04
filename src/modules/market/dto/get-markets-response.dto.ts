import { MarketOhlcvSeries } from './market-ohlcv.dto';

import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { MarketTokenKind, MarketType } from '@/types/market.types';

export interface MarketItem {
  id: string;
  vault_id: string | null;
  type: MarketType;
  token_kind: MarketTokenKind | null;
  name: string | null;
  contract_address: string | null;
  supply?: number;
  circSupply?: number;
  mcap?: number;
  totalSupply?: number;
  price_change_1h: number;
  price_change_24h: number;
  price_change_7d: number;
  price_change_30d: number;
  delta: number | null;
  fdv_per_asset_ada: number | null;
  fdv_per_asset_usd: number | null;
  created_at: Date;
  updated_at: Date;
  ticker: string | null;
  price_ada: number | null;
  price_usd: number | null;
  fdv_ada: number | null;
  fdv_usd: number | null;
  tvl_ada: number | null;
  tvl_usd: number | null;
  chain_type?: string | null;
  script_hash?: string | null;
  asset_vault_name?: string | null;
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
  vault_id: string | null;
  type: MarketType;
  name?: string | null;
  ticker?: string | null;
  token_image?: string | null;
  chain_type?: string | null;
  contract_address?: string | null;
  script_hash?: string | null;
  asset_vault_name?: string | null;
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
