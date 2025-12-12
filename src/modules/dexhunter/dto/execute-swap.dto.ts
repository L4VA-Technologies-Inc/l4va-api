export interface ExecuteSwapInput {
  /**
   * Token being sold (input token)
   */
  tokenIn: string;

  /**
   * Amount of input token to swap (in base units)
   */
  amountIn: number;

  /**
   * Maximum acceptable slippage tolerance (as percentage)
   */
  slippage?: number;
}

/**
 * Response after successfully executing a swap transaction
 * Contains transaction confirmation and swap execution details
 *
 * @example
 * ```typescript
 * {
 *   txHash: '8f3d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3',
 *   estimatedOutput: 4050000, // 4.05 ADA received
 *   actualSlippage: 1.22 // Actual slippage was 1.22%
 * }
 * ```
 */
export interface ExecuteSwapResponse {
  txHash: string;

  /**
   * Estimated amount of output tokens received (in base units)
   * - Based on the swap estimation at execution time
   * - Actual output may vary slightly due to on-chain conditions
   * @example 4050000 (4.05 ADA in lovelace)
   */
  estimatedOutput: number;

  /**
   * Actual slippage experienced during the swap (as percentage)
   * - Calculated as: (estimatedOutput - actualOutput) / estimatedOutput * 100
   * - Should be within the specified slippage tolerance
   * @example 1.22 (1.22% slippage)
   */
  actualSlippage: number;
}
