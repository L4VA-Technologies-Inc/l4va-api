import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';

export interface MarketItem {
  id: string;
  vault_id: string;
  circSupply: number;
  mcap: number;
  totalSupply: number;
  '1h': number;
  '24h': number;
  '7d': number;
  '30d': number;
  created_at: Date;
  updated_at: Date;
  ticker: string | null;
  price: number | null;
  tvl: number | null;
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
