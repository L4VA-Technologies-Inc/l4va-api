import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { encodeAbiParameters, type Address } from 'viem';

import { EvmContractReader } from './evm-contract-reader.service';

// Robinhood Chain (4663) Uniswap V3 deployment addresses.
export const UNISWAP_V3_ROBINHOOD = {
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address,
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2' as Address,
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as Address,
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa' as Address,
} as const;

/** Standard V3 fee tiers in basis points × 100 (hundredths of a bip). */
export const FEE_TIERS = {
  LOWEST: 100,
  LOW: 500,
  MEDIUM: 3000,
  HIGH: 10000,
} as const;

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export interface UniswapQuoteResult {
  /** Expected output amount in raw token units. */
  amountOut: bigint;
  /** Recommended fee tier for the swap. */
  fee: number;
  /** Minimum output applying `slippageBps` (basis points). Use as `minExpectedOutput`. */
  minAmountOut: bigint;
  /** ABI-encoded protocolParams for UniswapV3SwapAdapter: abi.encode(uint24 fee, uint160 sqrtPriceLimitX96). */
  protocolParams: `0x${string}`;
}

/**
 * Fetches swap quotes from Uniswap V3 on Robinhood Chain.
 *
 * Primary:  Uniswap Trading API (`/v1/quote`) — requires `UNISWAP_API_KEY`.
 * Fallback: On-chain QuoterV2 — no API key needed, always available.
 *
 * The returned `protocolParams` is ready to pass as-is to openPosition / closePosition
 * on the UniswapV3SwapAdapter contract.
 */
@Injectable()
export class UniswapQuoteService {
  private readonly logger = new Logger(UniswapQuoteService.name);
  private readonly chainId = 4663; // Robinhood Chain
  private readonly apiKey?: string;
  private readonly tradingApiBase = 'https://trade-api.gateway.uniswap.org/v1';

  constructor(
    private readonly contractReader: EvmContractReader,
    private readonly httpService: HttpService,
    configService: ConfigService
  ) {
    this.apiKey = configService.get<string>('UNISWAP_API_KEY');
  }

  /**
   * Get a quote for an exact-input single-hop swap.
   * @param tokenIn  ERC-20 input token address
   * @param tokenOut ERC-20 output token address
   * @param amountIn Exact input amount in raw token units
   * @param slippageBps Slippage tolerance in basis points (e.g. 50 = 0.5%)
   * @param feeTier  Optional fee tier override. Defaults to probing MEDIUM then LOW.
   */
  async quoteExactInput(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    slippageBps: number = 50,
    feeTier?: number
  ): Promise<UniswapQuoteResult> {
    if (this.apiKey) {
      try {
        return await this.quoteViaApi(tokenIn, tokenOut, amountIn, slippageBps, feeTier);
      } catch (err) {
        this.logger.warn(`Uniswap Trading API quote failed, falling back to QuoterV2: ${(err as Error).message}`);
      }
    }
    return this.quoteViaChain(tokenIn, tokenOut, amountIn, slippageBps, feeTier);
  }

  // ---------------------------------------------------------------------------
  // Trading API path
  // ---------------------------------------------------------------------------

  private async quoteViaApi(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    slippageBps: number,
    feeTier?: number
  ): Promise<UniswapQuoteResult> {
    const body = {
      tokenIn,
      tokenOut,
      tokenInChainId: this.chainId,
      tokenOutChainId: this.chainId,
      amount: amountIn.toString(),
      type: 'EXACT_INPUT',
      // For the adapter, we don't need swapper — no Permit2 involved.
      // The adapter holds the tokens directly.
    };

    const response = await firstValueFrom(
      this.httpService.post(`${this.tradingApiBase}/quote`, body, {
        headers: {
          'x-api-key': this.apiKey,
          'x-universal-router-version': '2.1.1',
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      })
    );

    const data = response.data as any;
    // Trading API returns output under quote.output.amount (v2 schema)
    const amountOutRaw: bigint = BigInt(
      data?.quote?.output?.amount ?? data?.quote?.amountOut ?? data?.quoteDecimals ?? 0
    );
    if (amountOutRaw === 0n) {
      throw new Error('Trading API returned zero amountOut');
    }

    // Extract fee tier from route if present; default to provided or MEDIUM.
    const resolvedFee =
      feeTier ?? data?.quote?.route?.[0]?.[0]?.fee ?? data?.quote?.routeString?.match(/(\d+)/)?.[1] ?? FEE_TIERS.MEDIUM;

    return this.buildResult(amountOutRaw, Number(resolvedFee), slippageBps);
  }

  // ---------------------------------------------------------------------------
  // On-chain QuoterV2 path
  // ---------------------------------------------------------------------------

  private async quoteViaChain(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    slippageBps: number,
    feeTier?: number
  ): Promise<UniswapQuoteResult> {
    // Probe fee tiers in descending liquidity order; use first that returns > 0.
    const tiersToTry = feeTier ? [feeTier] : [FEE_TIERS.MEDIUM, FEE_TIERS.LOW, FEE_TIERS.HIGH, FEE_TIERS.LOWEST];

    let bestAmountOut = 0n;
    let bestFee = tiersToTry[0];

    for (const fee of tiersToTry) {
      try {
        const [amountOut] = (
          await this.contractReader.publicClient.simulateContract({
            address: UNISWAP_V3_ROBINHOOD.quoterV2,
            abi: QUOTER_V2_ABI,
            functionName: 'quoteExactInputSingle',
            args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
          })
        ).result as [bigint, bigint, number, bigint];

        if (amountOut > bestAmountOut) {
          bestAmountOut = amountOut;
          bestFee = fee;
        }

        // If we got a quote and no feeTier was forced, stop at first success.
        if (!feeTier && amountOut > 0n) break;
      } catch {
        // Pool may not exist for this fee tier — try next.
      }
    }

    if (bestAmountOut === 0n) {
      throw new Error(`No Uniswap V3 quote available for ${tokenIn} → ${tokenOut} on Robinhood Chain`);
    }

    return this.buildResult(bestAmountOut, bestFee, slippageBps);
  }

  // ---------------------------------------------------------------------------

  private buildResult(amountOut: bigint, fee: number, slippageBps: number): UniswapQuoteResult {
    // minAmountOut = amountOut * (10000 - slippageBps) / 10000
    const minAmountOut = (amountOut * BigInt(10000 - slippageBps)) / 10000n;

    const protocolParams = encodeAbiParameters(
      [{ type: 'uint24' }, { type: 'uint160' }],
      [fee, 0n] // sqrtPriceLimitX96 = 0 → no price limit; rely on minAmountOut
    ) as `0x${string}`;

    return { amountOut, fee, minAmountOut, protocolParams };
  }
}
