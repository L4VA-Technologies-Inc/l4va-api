import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TapToolsPricingClient } from '../taptools/taptools-pricing.client';

import { DexHunterPricingClient } from './dexhunter-pricing.client';

/**
 * DexHunter Pricing Service - Orchestrates token pricing from multiple sources
 *
 * Pricing Strategy (TapTools-first with DexHunter fallback):
 * 1. Try TapToolsPricingClient first (primary source)
 * 2. If TapTools fails or returns null, try DexHunterPricingClient as fallback
 * 3. Return null only if both sources fail or have no data
 *
 * Both clients handle their own caching (5-minute TTL) to reduce redundant API calls.
 * This service acts as an orchestrator, delegating to specialized clients.
 *
 * Build Swap Flow:
 * 1. Estimate Swap - Get price quote and fee breakdown
 * 2. Build Swap Transaction - Get unsigned transaction CBOR from DexHunter | /swap/build
 * 3. Sign Transaction - Sign with treasury wallet private key
 * 4. Submit Transaction - Submit signed transaction to blockchain | /swap/sign
 *
 * @see https://docs.dexhunter.io for complete DexHunter API documentation
 */
@Injectable()
export class DexHunterPricingService {
  private readonly logger = new Logger(DexHunterPricingService.name);
  private readonly dexHunterBaseUrl: string;
  private readonly dexHunterApiKey: string;
  private readonly isMainnet: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly tapToolsClient: TapToolsPricingClient,
    private readonly dexHunterClient: DexHunterPricingClient
  ) {
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Sanitize error response text - detect HTML error pages and extract concise error info
   * Prevents massive HTML dumps in logs when external APIs return error pages
   * Used by checkTokenLiquidity method for DexHunter pool aggregation endpoint
   */
  private sanitizeErrorText(text: string, statusCode: number): string {
    // Detect HTML error pages (Cloudflare, nginx, etc.)
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      // Extract error code if present (e.g., "Error code 520")
      const errorCodeMatch = text.match(/Error code (\d+)/i);
      const errorCode = errorCodeMatch ? errorCodeMatch[1] : statusCode;

      // Extract title if present
      const titleMatch = text.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : 'HTML Error Page';

      // Check for Cloudflare-specific errors
      if (text.includes('cloudflare')) {
        return `Cloudflare error ${errorCode}: ${title} (upstream server issue)`;
      }

      return `HTML error page (${errorCode}): ${title}`;
    }

    // Not HTML - return original text (truncated if very long)
    return text.length > 500 ? text.substring(0, 500) + '... (truncated)' : text;
  }

  /**
   * Get current token price in ADA with DexHunter fallback
   * Uses TapToolsPricingClient first, falls back to DexHunterPricingClient if TapTools fails or returns null
   * Results are cached by clients for 5 minutes to reduce API calls
   *
   * Fallback strategy:
   * 1. Try TapToolsPricingClient first (primary source)
   * 2. If TapTools fails or returns null - try DexHunterPricingClient as fallback
   * 3. Return null only if both sources fail or have no data
   *
   * @param tokenId - The token identifier (policyId + assetName in hex)
   * @returns Token price in ADA, or null if token not found/no liquidity
   */
  async getTokenPrice(tokenId: string): Promise<number | null> {
    // Try TapTools API first (primary source)
    const tapToolsResult = await this.tapToolsClient.getTokenPrices([tokenId]);
    const tapToolsPrice = tapToolsResult.get(tokenId);

    if (tapToolsPrice !== null && tapToolsPrice > 0) {
      this.logger.debug(
        `Successfully fetched token price from TapTools (primary) for ${tokenId}: ${tapToolsPrice} ADA`
      );
      return tapToolsPrice;
    }

    // Fallback to DexHunter API
    this.logger.debug(`TapTools returned no price for token ${tokenId}, trying DexHunter fallback`);
    const dexHunterResult = await this.dexHunterClient.getTokenPrices([tokenId]);
    const dexHunterPrice = dexHunterResult.get(tokenId);

    if (dexHunterPrice !== null && dexHunterPrice > 0) {
      this.logger.log(`DexHunter provided fallback price for token ${tokenId}: ${dexHunterPrice} ADA`);
      return dexHunterPrice;
    }

    // Both sources failed or returned no data
    this.logger.debug(`No price data available from TapTools or DexHunter for token ${tokenId}`);
    return null;
  }

  /**
   * Get prices for multiple tokens in ADA with DexHunter fallback
   * Batch fetches prices for efficiency using dedicated pricing clients
   *
   * Fallback strategy:
   * 1. Try fetching all prices from TapToolsPricingClient first (primary source, native batch support)
   * 2. For any tokens that returned null, try DexHunterPricingClient as fallback (in batch)
   *
   * Both clients handle their own caching and batch optimization.
   *
   * @param tokenIds - Array of token identifiers (policyId + assetName in hex)
   * @returns Map of tokenId to price in ADA (null if not found)
   */
  async getTokenPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    this.logger.log(`Fetching prices for ${tokenIds.length} tokens`);

    // Try TapTools API first (primary source with native batch support)
    const tapToolsResults = await this.tapToolsClient.getTokenPrices(tokenIds);

    // Find tokens that still have null prices and need DexHunter fallback
    const tokensNeedingFallback = tokenIds.filter(tokenId => {
      const price = tapToolsResults.get(tokenId);
      return price === null || price === undefined;
    });

    if (tokensNeedingFallback.length > 0) {
      this.logger.log(
        `${tokensNeedingFallback.length} tokens had no price from TapTools, trying DexHunter fallback in batch`
      );
      const dexHunterResults = await this.dexHunterClient.getTokenPrices(tokensNeedingFallback);

      // Merge DexHunter fallback results into main result map
      dexHunterResults.forEach((price, tokenId) => {
        if (price !== null && price > 0) {
          tapToolsResults.set(tokenId, price);
          this.logger.debug(`DexHunter provided fallback price for token ${tokenId}: ${price} ADA`);
        }
      });
    }

    return tapToolsResults;
  }

  /**
   * Check if token has liquidity pools across ALL DEXes
   * Returns aggregated pool data from MinSwap, VyFi, SundaeSwap, Spectrum, etc.
   *
   * Note: This method uses DexHunter's pool aggregation endpoint (/stats/pools) directly,
   * not the pricing clients. DexHunter is currently the only source for multi-DEX pool aggregation.
   *
   * This is superior to checking individual DEX APIs because:
   * - Community can create LP on ANY DEX, not just VyFi
   * - Returns total liquidity across entire ecosystem
   * - Better price discovery from multiple sources
   *
   * @param tokenId - The token identifier (policyId + assetName in hex)
   * @returns Pool statistics if liquidity exists, null otherwise
   */
  async checkTokenLiquidity(tokenId: string): Promise<{
    hasLiquidity: boolean;
    totalAdaLiquidity: number;
    pools: Array<{
      dex: string;
      adaAmount: number;
      tokenAmount: number;
      poolId: string;
      fee: number;
    }>;
  } | null> {
    // Skip API calls for testnet
    if (!this.isMainnet) {
      this.logger.debug(`Skipping DexHunter liquidity check for testnet token ${tokenId}`);
      return null;
    }

    try {
      const response = await fetch(`${this.dexHunterBaseUrl}/stats/pools/ADA/${tokenId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Id': this.dexHunterApiKey,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug(`No liquidity pools found for token ${tokenId}`);
          return {
            hasLiquidity: false,
            totalAdaLiquidity: 0,
            pools: [],
          };
        }
        const errorText = await response.text();
        const sanitizedError = this.sanitizeErrorText(errorText, response.status);
        throw new Error(`DexHunter API error: ${response.status} - ${sanitizedError}`);
      }

      const data: Array<{
        dex_name: string;
        token_1_amount: number; // ADA amount
        token_2_amount: number; // Token amount
        pool_id: string;
        pool_fee: number;
      }> = await response.json();

      if (!data || data.length === 0) {
        return {
          hasLiquidity: false,
          totalAdaLiquidity: 0,
          pools: [],
        };
      }

      // Calculate total ADA liquidity across all DEXes
      const totalAdaLiquidity = data.reduce((sum, pool) => sum + (pool.token_1_amount || 0), 0);

      const pools = data.map(pool => ({
        dex: pool.dex_name,
        adaAmount: pool.token_1_amount || 0,
        tokenAmount: pool.token_2_amount || 0,
        poolId: pool.pool_id,
        fee: pool.pool_fee,
      }));

      this.logger.debug(
        `Token ${tokenId.slice(0, 6)}...${tokenId.slice(-6)} has liquidity across ${pools.length} DEX(es): ` +
          `${pools.map(p => `${p.dex} (${p.adaAmount.toFixed(2)} ADA)`).join(', ')}`
      );

      return {
        hasLiquidity: totalAdaLiquidity > 0,
        totalAdaLiquidity,
        pools,
      };
    } catch (error) {
      this.logger.error(`Failed to check token liquidity for ${tokenId}`, error);
      return null;
    }
  }
}
