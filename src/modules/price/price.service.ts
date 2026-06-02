import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import NodeCache from 'node-cache';

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache = new NodeCache({ stdTTL: 600 });
  private readonly dexHunterApiKey: string;
  private readonly dexHunterBaseUrl: string;
  private readonly tapToolsApiKey: string;
  private readonly tapToolsApiUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.tapToolsApiKey = this.configService.get<string>('TAPTOOLS_API_KEY');
    this.tapToolsApiUrl = this.configService.get<string>('TAPTOOLS_API_URL');
  }

  async getAdaPrice(): Promise<number> {
    const cacheKey = 'ada_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);

    if (cachedPrice !== undefined) {
      return cachedPrice;
    }

    const fallbackPrice = 0.25;

    try {
      const now = Date.now();
      const lastCallKey = 'last_price_api_call';
      const lastCall = this.cache.get<number>(lastCallKey) || 0;

      // Rate limiting: don't call API more than once per 10 seconds
      if (now - lastCall < 10000) {
        const lastKnownGoodPrice = this.cache.get<number>('last_known_good_ada_price');
        return lastKnownGoodPrice || fallbackPrice;
      }

      this.cache.set(lastCallKey, now);

      // Call DexHunter API
      try {
        const response = await axios.get(`${this.dexHunterBaseUrl}/swap/adaValue`, {
          headers: {
            'X-Partner-Id': this.dexHunterApiKey,
          },
          timeout: 5000,
        });

        if (!response.data || typeof response.data !== 'number') {
          throw new Error('Invalid price data from DexHunter API');
        }

        const adaPrice = Number(response.data);

        // Cache price for 15 minutes
        this.cache.set(cacheKey, adaPrice, 900);
        this.cache.set('last_known_good_ada_price', adaPrice, 86400);

        return adaPrice;
      } catch (dexHunterError) {
        this.logger.warn(`DexHunter API failed: ${dexHunterError.message}. Trying TapTools...`);

        // Fallback to TapTools API
        try {
          const tapToolsResponse = await axios.get(`${this.tapToolsApiUrl}/token/quote`, {
            params: { quote: 'USD' },
            headers: {
              'X-API-Key': this.tapToolsApiKey,
            },
            timeout: 5000,
          });

          if (!tapToolsResponse.data || typeof tapToolsResponse.data.price !== 'number') {
            throw new Error('Invalid price data from TapTools API');
          }

          const adaPrice = Number(tapToolsResponse.data.price);

          // Cache price for 15 minutes
          this.cache.set(cacheKey, adaPrice, 900);
          this.cache.set('last_known_good_ada_price', adaPrice, 86400);

          this.logger.log(`Successfully fetched ADA price from TapTools: $${adaPrice.toFixed(4)}`);
          return adaPrice;
        } catch (tapToolsError) {
          this.logger.error(`TapTools API also failed: ${tapToolsError.message}`);
          throw new Error('Both DexHunter and TapTools APIs failed');
        }
      }
    } catch (error) {
      this.logger.error(`Failed to fetch ADA price: ${error.message}`);

      // If we have a last known good price, use that
      const lastKnownGoodPrice = this.cache.get<number>('last_known_good_ada_price');
      if (lastKnownGoodPrice !== undefined) {
        this.logger.warn(`Using last known good ADA price: $${lastKnownGoodPrice.toFixed(4)}`);
        return lastKnownGoodPrice;
      }

      // Use fallback price as last resort
      this.logger.warn(`Using fallback ADA price: $${fallbackPrice}`);
      return fallbackPrice;
    }
  }
}
