export type TokenSource = 'vault' | 'robinhood' | 'cardano' | 'coingecko';

export type TokenOverviewField = 'mcap' | 'fdv' | 'liquidity' | 'holders' | 'volume' | 'high' | 'low';

export type TokenSwapKind = 'uniswap' | 'dexhunter';

export const TOKEN_CHART_INTERVALS = ['1h', '1d', '1w', '1m', '3m', '1y'] as const;
export type TokenChartInterval = (typeof TOKEN_CHART_INTERVALS)[number];

export interface TokenSwap {
  kind: TokenSwapKind;
  token: string;
}

export interface TokenOhlcvPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TokenTrade {
  tx_hash: string;
  kind: 'buy' | 'sell';
  price_usd: number | null;
  amount_token: number | null;
  volume_usd: number | null;
  timestamp: string | null;
  tx_url: string | null;
}

/** Page-ready token detail. Frontend should render this as-is — no NAV/unit/unwrap logic. */
export interface TokenDetail {
  id: string;
  source: TokenSource;
  name: string | null;
  symbol: string | null;
  image: string | null;
  price_usd: number | null;
  price_eth: number | null;
  price_ada: number | null;
  market_cap: number | null;
  market_cap_eth: number | null;
  market_cap_ada: number | null;
  fdv: number | null;
  fdv_eth: number | null;
  fdv_ada: number | null;
  volume_24h: number | null;
  volume_24h_eth: number | null;
  volume_24h_ada: number | null;
  liquidity_usd: number | null;
  liquidity_eth: number | null;
  liquidity_ada: number | null;
  change_24h: number | null;
  high_24h: number | null;
  high_24h_eth: number | null;
  high_24h_ada: number | null;
  low_24h: number | null;
  low_24h_eth: number | null;
  low_24h_ada: number | null;
  holders_count: number | null;
  chain_type: string | null;
  vault_id: string | null;
  contract_address: string | null;
  copy_value: string;
  explorer_url: string | null;
  has_live_trades: boolean;
  chart_kind: 'nav' | 'usd';
  overview_fields: TokenOverviewField[];
  swap: TokenSwap | null;
}
