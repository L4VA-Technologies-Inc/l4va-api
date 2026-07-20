import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import NodeCache from 'node-cache';

import { NexusClient } from '@/modules/nexus/nexus.client';

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cache = new NodeCache({ stdTTL: 600 });
  private readonly dexHunterApiKey: string;
  private readonly dexHunterBaseUrl: string;
  private readonly coinGeckoApiKey: string;
  private readonly coinGeckoApiUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly nexusClient: NexusClient
  ) {
    this.dexHunterApiKey = this.configService.get<string>('DEXHUNTER_API_KEY');
    this.dexHunterBaseUrl = this.configService.get<string>('DEXHUNTER_BASE_URL');
    this.coinGeckoApiKey = this.configService.get<string>('COINGECKO_API_KEY');
    this.coinGeckoApiUrl = this.configService.get<string>('COINGECKO_API_URL');
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
        this.logger.warn(`DexHunter API failed: ${dexHunterError.message}. Trying Nexus...`);

        // Fallback to Nexus API using NexusClient
        const adaPrice = await this.nexusClient.getAdaPrice();

        if (adaPrice === null) {
          throw new Error('Both DexHunter and Nexus APIs failed');
        }

        // Cache price for 15 minutes
        this.cache.set(cacheKey, adaPrice, 900);
        this.cache.set('last_known_good_ada_price', adaPrice, 86400);

        this.logger.log(`Successfully fetched ADA price from Nexus: $${adaPrice.toFixed(4)}`);
        return adaPrice;
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

  async getEthPrice(): Promise<number> {
    const cacheKey = 'eth_price_usd';
    const cachedPrice = this.cache.get<number>(cacheKey);

    if (cachedPrice !== undefined) {
      return cachedPrice;
    }

    const fallbackPrice = 3000;

    try {
      const now = Date.now();
      const lastCallKey = 'last_eth_price_api_call';
      const lastCall = this.cache.get<number>(lastCallKey) || 0;

      // Rate limiting: don't call API more than once per 10 seconds
      if (now - lastCall < 10000) {
        const lastKnownGoodPrice = this.cache.get<number>('last_known_good_eth_price');
        this.logger.log(`lastKnownGoodPrice: ${lastKnownGoodPrice}`);
        return lastKnownGoodPrice || fallbackPrice;
      }

      this.cache.set(lastCallKey, now);

      // Call CoinGecko API
      const response = await axios.get(`${this.coinGeckoApiUrl}/v3/simple/price`, {
        params: {
          ids: 'ethereum',
          vs_currencies: 'usd',
        },
        headers: {
          'x-cg-demo-api-key': this.coinGeckoApiKey,
        },
        timeout: 5000,
      });

      const ethPrice = Number(response.data?.ethereum?.usd);

      if (!ethPrice || Number.isNaN(ethPrice)) {
        throw new Error('Invalid price data from CoinGecko API');
      }

      // Cache price for 15 minutes
      this.cache.set(cacheKey, ethPrice, 900);
      this.cache.set('last_known_good_eth_price', ethPrice, 86400);

      this.logger.log(`Successfully fetched ETH price from CoinGecko: $${ethPrice.toFixed(2)}`);
      this.logger.log(`ethPrice: ${ethPrice}`);
      return ethPrice;
    } catch (error) {
      this.logger.error(`Failed to fetch ETH price: ${error.message}`);

      // If we have a last known good price, use that
      const lastKnownGoodPrice = this.cache.get<number>('last_known_good_eth_price');
      if (lastKnownGoodPrice !== undefined) {
        this.logger.warn(`Using last known good ETH price: $${lastKnownGoodPrice.toFixed(2)}`);
        return lastKnownGoodPrice;
      }

      // Use fallback price as last resort
      this.logger.warn(`Using fallback ETH price: $${fallbackPrice}`);
      return fallbackPrice;
    }
  }
}
