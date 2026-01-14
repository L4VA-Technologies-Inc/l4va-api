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
      this.logger.debug(`Token ${tokenId} price: ${priceAda} ADA`);

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
}
