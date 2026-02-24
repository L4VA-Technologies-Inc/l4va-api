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
  private readonly isMainnet: boolean;

  constructor(private readonly configService: ConfigService) {
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
  }

  /**
   * Get current token price in ADA using DexHunter API
   * Uses the average price endpoint to get the current market price
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
          this.logger.debug(`Token ${tokenId} not found or has no liquidity`);
          return null;
        }
        const errorText = await response.text();
        throw new Error(`DexHunter API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      const priceAda = data.price_ba;
      return priceAda;
    } catch (error) {
      this.logger.error(`Failed to fetch token price for ${tokenId}`, error);
      return null;
    }
  }

  /**
   * Get prices for multiple tokens in ADA
   * Batch fetches prices for efficiency
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
        throw new Error(`DexHunter API error: ${response.status} - ${errorText}`);
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
        `Token ${tokenId} has liquidity across ${pools.length} DEX(es): ` +
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
