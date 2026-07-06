import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AnvilApiCache } from '@/database/anvil-api-cache.entity';

/**
 * Anvil API response types
 */
export interface StakeCollectionInfoResponse {
  stakeCollectionId: number;
  policyId: string;
  name: string;
  maxPerTransaction: number;
  // ... other fields from API
}

export interface GetStakesResponse {
  stakes: Array<{
    stakeId: string;
    assetUnit: string;
    rewards: string;
    stakedAt: number;
  }>;
}

export interface StakeAssetsResponse {
  unsignedTx: string; // CBOR hex
  stakeIds: string[];
}

export interface SubmitStakeResponse {
  txHash: string;
  success: boolean;
}

export interface HarvestStakeResponse {
  unsignedTx: string; // CBOR hex
  rewards: string;
}

export interface EvaluateStakeResponse {
  stakeId: string;
  rewards: string;
  canHarvest: boolean;
}

/**
 * Client for Anvil Relics Staking API
 * Handles all HTTP requests to Anvil endpoints with caching
 */
@Injectable()
export class AnvilApiClient {
  private readonly logger = new Logger(AnvilApiClient.name);
  private readonly baseUrl = 'https://us-central1-anvil-6fe83.cloudfunctions.net';

  constructor(
    @InjectRepository(AnvilApiCache)
    private readonly cacheRepository: Repository<AnvilApiCache>
  ) {}

  /**
   * Get stake collection information (cached for 1 hour)
   */
  async stakeCollectionInfoV2(stakeCollectionId: number): Promise<StakeCollectionInfoResponse> {
    const endpoint = '/stakeCollectionInfoV2';
    const payload = { stakeCollectionId };
    const ttl = 60 * 60 * 1000; // 1 hour

    return this.cachedRequest<StakeCollectionInfoResponse>(endpoint, payload, ttl);
  }

  /**
   * Get stakes for a wallet address (cached for 5 minutes)
   */
  async getStakesV2(walletAddress: string): Promise<GetStakesResponse> {
    const endpoint = '/getStakesV2';
    const payload = { walletAddress };
    const ttl = 5 * 60 * 1000; // 5 minutes

    return this.cachedRequest<GetStakesResponse>(endpoint, payload, ttl);
  }

  /**
   * Build unsigned stake transaction
   * @param walletAddress Treasury wallet address
   * @param assetUnits Array of asset units (policy.assetName format)
   * @param stakeCollectionId Collection ID (54 for Relics)
   */
  async stakeAssetsV2(
    walletAddress: string,
    assetUnits: string[],
    stakeCollectionId: number
  ): Promise<StakeAssetsResponse> {
    const endpoint = '/stakeAssetsV2';
    const payload = { walletAddress, assetUnits, stakeCollectionId };

    // No caching for write operations
    return this.makeRequest<StakeAssetsResponse>(endpoint, payload);
  }

  /**
   * Submit signed stake transaction
   */
  async submitStakeV2(signedTxCbor: string): Promise<SubmitStakeResponse> {
    const endpoint = '/submitStakeV2';
    const payload = { signedTx: signedTxCbor };

    return this.makeRequest<SubmitStakeResponse>(endpoint, payload);
  }

  /**
   * Build unsigned harvest (unstake) transaction
   */
  async harvestStakeV2(
    walletAddress: string,
    stakeIds: string[],
    evaluateOnly: boolean = false
  ): Promise<HarvestStakeResponse> {
    const endpoint = '/harvestStakeV2';
    const payload = { walletAddress, stakeIds, evaluateOnly };

    if (evaluateOnly) {
      // Cache evaluation results for 5 minutes
      const ttl = 5 * 60 * 1000;
      return this.cachedRequest<HarvestStakeResponse>(endpoint, payload, ttl);
    }

    return this.makeRequest<HarvestStakeResponse>(endpoint, payload);
  }

  /**
   * Evaluate stake rewards (cached for 5 minutes)
   */
  async evaluateStakeV2(stakeId: string): Promise<EvaluateStakeResponse> {
    const endpoint = '/evaluateStakeV2';
    const payload = { stakeId };
    const ttl = 5 * 60 * 1000;

    return this.cachedRequest<EvaluateStakeResponse>(endpoint, payload, ttl);
  }

  /**
   * Make cached HTTP request
   */
  private async cachedRequest<T>(endpoint: string, payload: any, ttlMs: number): Promise<T> {
    const cacheKey = this.generateCacheKey(endpoint, payload);

    // Check cache
    const cached = await this.cacheRepository.findOne({
      where: {
        endpoint,
        request_payload: payload,
      },
    });

    if (cached && cached.expires_at > new Date()) {
      this.logger.debug(`Cache hit for ${endpoint}`);
      return cached.response_data as T;
    }

    // Cache miss - make request
    this.logger.debug(`Cache miss for ${endpoint}, fetching from API`);
    const response = await this.makeRequest<T>(endpoint, payload);

    // Store in cache
    const expiresAt = new Date(Date.now() + ttlMs);
    if (cached) {
      cached.response_data = response;
      cached.expires_at = expiresAt;
      cached.created_at = new Date();
      await this.cacheRepository.save(cached);
    } else {
      await this.cacheRepository.save({
        endpoint,
        request_payload: payload,
        response_data: response,
        expires_at: expiresAt,
      });
    }

    return response;
  }

  /**
   * Make HTTP request to Anvil API
   */
  private async makeRequest<T>(endpoint: string, payload: any): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anvil API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      this.logger.error(`Anvil API request failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Generate cache key from endpoint and payload
   */
  private generateCacheKey(endpoint: string, payload: any): string {
    const payloadStr = JSON.stringify(payload);
    return crypto.createHash('sha256').update(`${endpoint}:${payloadStr}`).digest('hex');
  }

  /**
   * Clear expired cache entries
   */
  async clearExpiredCache(): Promise<void> {
    const result = await this.cacheRepository.createQueryBuilder().delete().where('expires_at < NOW()').execute();

    this.logger.log(`Cleared ${result.affected} expired cache entries`);
  }
}
