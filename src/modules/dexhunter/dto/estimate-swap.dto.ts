export interface EstimateSwapInput {
  /**
   * Token being sold (input token)
   */
  tokenIn: string;

  /**
   * Token being bought (output token) or 'ADA' for native ADA
   */
  tokenOut: string;

  /**
   * Amount of input token to swap (in base units)
   */
  amountIn: number;

  /**
   * Maximum acceptable slippage tolerance as a percentage
   */
  slippage?: number;
}

export interface EstimateSwapResponse {
  /**
   * Average exchange rate for the token pair across all DEXes
   * - Expressed as: 1 TokenIn = X TokenOut
   * - Used for reference pricing
   * @example 0.00001234 (1 SNEK = 0.00001234 ADA)
   */
  averagePrice: number;

  /**
   * Net price after all fees are applied
   * - Accounts for batcher fees, protocol fees, and slippage
   * - This is the effective exchange rate you'll receive
   * @example 0.00001200 (actual price after fees)
   */
  netPrice: number;

  /**
   * Total amount of output token you will receive (in base units)
   * - Includes slippage protection
   * - This is the minimum guaranteed output
   * @example 4050000 (4.05 ADA in lovelace)
   */
  totalOutput: number;

  /**
   * Estimated output without slippage protection (in base units)
   * - Best case scenario if price doesn't move
   * - Used to calculate actual slippage
   * @example 4100000 (4.10 ADA in lovelace)
   */
  totalOutputWithoutSlippage: number;

  /**
   * Fee charged by the batcher for transaction execution (in lovelace)
   * - Fixed fee for processing the swap transaction
   * - Typically 1-2 ADA depending on the DEX
   * @example 2000000 (2 ADA)
   */
  batcherFee: number;

  /**
   * Fee charged by DexHunter protocol (in lovelace)
   * - Protocol fee for routing and optimization services
   * @example 25000 (0.025 ADA)
   */
  dexhunterFee: number;

  /**
   * Fee shared with integration partner (in lovelace)
   * - Revenue share for partners using DexHunter API
   * @example 25000 (0.025 ADA)
   */
  partnerFee: number;

  /**
   * Refundable deposit required for the transaction (in lovelace)
   * - Temporary deposit locked during swap execution
   * - Returned after transaction completes
   * @example 2000000 (2 ADA)
   */
  deposits: number;

  /**
   * Sum of all fees (batcher + dexhunter + partner fees) (in lovelace)
   * - Does not include deposits (which are refundable)
   * @example 4050000 (4.05 ADA total fees)
   */
  totalFee: number;

  /**
   * Array of swap routes split across multiple DEXes
   * - DexHunter optimizes by splitting orders across DEXes for best price
   * - Each split represents a portion of the trade on a specific DEX
   */
  splits: SwapSplit[];
}

/**
 * Represents a single swap route split on a specific DEX
 * DexHunter optimizes swaps by splitting orders across multiple DEXes
 * to minimize price impact and maximize output
 */
export interface SwapSplit {
  /**
   * Name of the DEX where this portion of the swap is executed
   */
  dex: string;

  /**
   * Amount of input token allocated to this DEX (in base units)
   */
  amountIn: number;

  /**
   * Expected output amount from this DEX split (in base units)
   */
  amountOut: number;

  /**
   * Price impact on this specific DEX (as percentage)
   */
  priceImpact: number;
}
