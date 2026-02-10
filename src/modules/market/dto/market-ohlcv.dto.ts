export interface MarketOhlcvPoint {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

export type MarketOhlcvSeries = MarketOhlcvPoint[];
