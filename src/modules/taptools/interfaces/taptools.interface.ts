/**
 * TapTools LP Pool data structure
 * Represents a liquidity pool from TapTools API
 */
export interface TapToolsTokenPoolDto {
  exchange: string;
  lpTokenUnit: string;
  onchainID: string;
  tokenA: string;
  tokenALocked: number;
  tokenATicker: string;
  /** empty for ADA */
  tokenB: string | null;
  tokenBLocked: number;
  tokenBTicker: string;
  /** LP token total supply from Nexus/VyFi APIs (null if unavailable) */
  lpTotalSupply: number | null;
}
