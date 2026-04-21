import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Build Swap Flow
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
  private readonly tapToolsApiKey: string;
  private readonly tapToolsApiUrl: string;
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Sanitize error response text - detect HTML error pages and extract concise error info
   * Prevents massive HTML dumps in logs when external APIs return error pages
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
  /**
   * Fetch token prices from TapTools API in batch
   * @param tokenIds - Array of token identifiers
   * @returns Map of tokenId to price in ADA
   */
  private async fetchTokenPricesFromTapTools(tokenIds: string[]): Promise<Map<string, number | null>> {
    const priceMap = new Map<string, number | null>();

    // TapTools supports max 100 tokens per batch
    const batchSize = 100;
    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);

      try {
        const response = await fetch(`${this.tapToolsApiUrl}/token/prices`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.tapToolsApiKey,
          },
          body: JSON.stringify(batch),
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.warn(`TapTools batch API failed: ${response.status} - ${errorText}`);
          // Set all tokens in batch to null
          batch.forEach(tokenId => priceMap.set(tokenId, null));
          continue;
        }

        const data = await response.json();

        // Map response to price map
        batch.forEach(tokenId => {
          const price = data[tokenId];
          priceMap.set(tokenId, price !== undefined && price !== null ? price : null);
        });
      } catch (error) {
        this.logger.warn(`TapTools batch request failed for batch ${i / batchSize + 1}`, error);
        // Set all tokens in batch to null
        batch.forEach(tokenId => priceMap.set(tokenId, null));
      }
    }

    return priceMap;
  }

  /**
   * Get current token price in ADA with TapTools fallback
   * Uses DexHunter API first, falls back to TapTools if DexHunter fails or returns null
   *
   * Fallback strategy:
   * 1. Try DexHunter API first
   * 2. If DexHunter fails (404, 500, 401, etc.) or returns null - try TapTools API
   * 3. Return null only if both APIs fail or have no data
   *
   * @param tokenId - The token identifier (policyId + assetName in hex)
   * @returns Token price in ADA, or null if token not found/no liquidity
   */
  async getTokenPrice(tokenId: string): Promise<number | null> {
    // Skip API calls for testnet - DexHunter doesn't support preprod
    if (!this.isMainnet) {
      this.logger.debug(`Skipping DexHunter API call for testnet token ${tokenId}`);
      return null;
    }

    let dexHunterResult: number | null = null;

    // Try DexHunter API first
    try {
      const response = await fetch(`${this.dexHunterBaseUrl}/swap/averagePrice/ADA/${tokenId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Partner-Id': this.dexHunterApiKey,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug(`DexHunter: Token ${tokenId} not found or has no liquidity, trying TapTools fallback`);
        } else {
          const errorText = await response.text();
          const sanitizedError = this.sanitizeErrorText(errorText, response.status);
          this.logger.warn(`DexHunter API error (${response.status}): ${sanitizedError}, trying TapTools fallback`);
        }
      } else {
        const data = await response.json();
        const priceAda = data.price_ba;

        if (priceAda && priceAda > 0) {
          dexHunterResult = priceAda;
        } else {
          this.logger.debug(`DexHunter returned zero/null price for token ${tokenId}, trying TapTools fallback`);
        }
      }
    } catch (error) {
      this.logger.warn(`DexHunter API failed for token ${tokenId}, trying TapTools fallback`, error);
    }

    // If DexHunter succeeded with valid data, return it
    if (dexHunterResult) {
      return dexHunterResult;
    }

    // Fallback to TapTools API
    const tapToolsResult = await this.fetchTokenPricesFromTapTools([tokenId]).then(map => map.get(tokenId) || null);

    if (tapToolsResult !== null && tapToolsResult > 0) {
      this.logger.log(`Successfully fetched token price from TapTools for ${tokenId}: ${tapToolsResult} ADA`);
      return tapToolsResult;
    }

    // Both APIs failed or returned no data
    this.logger.debug(`No price data available from DexHunter or TapTools for token ${tokenId}`);
    return null;
  }

  /**
   * Get prices for multiple tokens in ADA with TapTools fallback
   * Batch fetches prices for efficiency
   *
   * Fallback strategy:
   * 1. Try fetching all prices from DexHunter first (in parallel batches)
   * 2. For any tokens that returned null, try TapTools as fallback (in single batch)
   *
   * @param tokenIds - Array of token identifiers (policyId + assetName in hex)
   * @returns Map of tokenId to price in ADA (null if not found)
   */
  async getTokenPrices(tokenIds: string[]): Promise<Map<string, number | null>> {
    this.logger.log(`Fetching prices for ${tokenIds.length} tokens`);

    const priceMap = new Map<string, number | null>();

    // Fetch prices in parallel with concurrency limit
    const batchSize = 10;
    for (let i = 0; i < tokenIds.length; i += batchSize) {
      const batch = tokenIds.slice(i, i + batchSize);
      const prices = await Promise.all(batch.map(tokenId => this.getTokenPrice(tokenId)));

      batch.forEach((tokenId, index) => {
        priceMap.set(tokenId, prices[index]);
      });
    }

    // Find tokens that still have null prices and try TapTools fallback
    const tokensNeedingFallback = tokenIds.filter(tokenId => priceMap.get(tokenId) === null);

    if (tokensNeedingFallback.length > 0) {
      this.logger.log(
        `${tokensNeedingFallback.length} tokens had no price from DexHunter, trying TapTools fallback in batch`
      );
      const tapToolsPrices = await this.fetchTokenPricesFromTapTools(tokensNeedingFallback);

      // Update price map with TapTools results
      tapToolsPrices.forEach((price, tokenId) => {
        if (price !== null && price > 0) {
          priceMap.set(tokenId, price);
          this.logger.debug(`TapTools provided fallback price for token ${tokenId}: ${price} ADA`);
        }
      });
    }

    return priceMap;
  }

  /**
   * Check if token has liquidity pools across ALL DEXes
   * Returns aggregated pool data from MinSwap, VyFi, SundaeSwap, Spectrum, etc.
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

      this.logger.log(
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
