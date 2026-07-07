import { createHash } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '@/modules/redis/redis.module';

// ---------------------------------------------------------------------------
// Request / response types matching the real Anvil Firebase functions API
// ---------------------------------------------------------------------------

export interface AnvilStakeAsset {
  /** full unit = policyId + assetNameHex (no dot separator) */
  unit: string;
  quantity: 1;
}

/** POST /stakeEvalV2 response */
export interface StakeEvalV2Response {
  success: boolean;
  result: {
    total: Array<{ unit: string; quantity: number }>;
    breakdown: Record<string, Array<{ unit: string; quantity: number }>>;
    mint: any[];
  };
}

/** POST /stakeAssetsV2 response – one stakeId even for multi-asset batches */
export interface StakeAssetsV2Response {
  success: boolean;
  transaction: string; // unsigned tx CBOR hex
  stakeId: number;
}

/** POST /submitStakeV2 response */
export interface SubmitStakeV2Response {
  success: boolean;
  txHash: string;
}

/** POST /harvestStakeV2 response */
export interface HarvestStakeV2Response {
  success: boolean;
  transaction: string; // unsigned tx CBOR hex
}

/** A single Anvil stake position (from getStakesV2) */
export interface AnvilStakePosition {
  id: number;
  stakeCollectionId: number;
  status: string;
  claimed: boolean;
  deleted: boolean;
  startAt: string;
  endAt: string;
  rewards: any;
  transactionId: number;
  keyhash: string;
  address: string;
  claimId: number | null;
  deposit: any;
  harvest: any;
  harvestByAssets: any[];
  assets: Array<{
    saId: number;
    id: number;
    stakeId: number;
    unit: string;
    quantity: number;
    policyId: string;
    assetName: string;
    metadata: any;
    available: boolean;
    rarity?: number;
  }>;
  result: {
    total: Array<{ unit: string; quantity: number }>;
    breakdown: Record<string, Array<{ unit: string; quantity: number }>>;
    mint: any[];
  };
}

/** POST /getStakesV2 response */
export interface GetStakesV2Response {
  success: boolean;
  stakes: AnvilStakePosition[];
}

// ---------------------------------------------------------------------------
// Cache constants
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'anvil:relics:v1';
/** TTL for stakeEvalV2 and getStakesV2 results (seconds) */
const READ_CACHE_TTL_SECONDS = 60;

/**
 * Produce a stable JSON string whose key order is consistent regardless of
 * property insertion order. Required for deterministic cache key generation.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as object)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = (val as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return val;
  });
}

/**
 * Anvil Relics Staking Firebase functions API client.
 *
 * Caching policy:
 *  - stakeEvalV2  →  Redis, 60 s TTL  (reward estimates)
 *  - getStakesV2  →  Redis, 60 s TTL  (live stake state)
 *  - stakeAssetsV2, submitStakeV2, harvestStakeV2  →  NEVER cached
 *    (depend on current UTxOs, validity intervals, and chain state)
 *
 * Redis failures degrade gracefully: the client falls through to Anvil.
 */
@Injectable()
export class AnvilApiClient {
  private readonly logger = new Logger(AnvilApiClient.name);
  private readonly baseUrl = 'https://us-central1-anvil-6fe83.cloudfunctions.net';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ---------------------------------------------------------------------------
  // Read endpoints – cached in Redis
  // ---------------------------------------------------------------------------

  /**
   * Evaluate estimated VLRM rewards for a set of assets before staking.
   * Cached for {@link READ_CACHE_TTL_SECONDS} seconds.
   */
  async stakeEvalV2(stakeCollectionId: number, assets: AnvilStakeAsset[]): Promise<StakeEvalV2Response> {
    const payload = { stakeCollectionId, assets };
    return this.cachedRequest<StakeEvalV2Response>('/stakeEvalV2', payload, READ_CACHE_TTL_SECONDS);
  }

  /**
   * Get all active stakes for a treasury address.
   * Cached for {@link READ_CACHE_TTL_SECONDS} seconds.
   */
  async getStakesV2(stakeCollectionId: number, changeAddress: string): Promise<GetStakesV2Response> {
    const payload = { stakeCollectionId, changeAddress };
    return this.cachedRequest<GetStakesV2Response>('/getStakesV2', payload, READ_CACHE_TTL_SECONDS);
  }

  // ---------------------------------------------------------------------------
  // Write endpoints – never cached
  // ---------------------------------------------------------------------------

  /**
   * Build an unsigned stake transaction for a batch of assets.
   * NOT cached – depends on live UTxOs and validity interval.
   */
  async stakeAssetsV2(params: {
    stakeCollectionId: number;
    assets: AnvilStakeAsset[];
    changeAddress: string;
    utxos: string[];
  }): Promise<StakeAssetsV2Response> {
    const payload = {
      stakeCollectionId: params.stakeCollectionId,
      assets: params.assets,
      seconds: 1,
      options: {},
      changeAddress: params.changeAddress,
      utxos: params.utxos,
      wallet: 'eternl',
    };
    return this.makeRequest<StakeAssetsV2Response>('/stakeAssetsV2', payload);
  }

  /**
   * Submit a signed stake transaction and register it with Anvil.
   * NOT cached.
   *
   * After a successful call, invalidate the {@link getStakesV2} cache for the
   * treasury address so the next read reflects the new staking position.
   */
  async submitStakeV2(params: {
    transaction: string;
    stakeId: number;
    signature: string;
    context?: string;
    /** Hex-encoded treasury address – used to invalidate getStakesV2 cache */
    changeAddress?: string;
    stakeCollectionId?: number;
  }): Promise<SubmitStakeV2Response> {
    const payload = {
      transaction: params.transaction,
      stakeId: params.stakeId,
      signature: params.signature,
      mainnet: true,
      context: params.context ?? 'STAKING',
    };
    const response = await this.makeRequest<SubmitStakeV2Response>('/submitStakeV2', payload);

    // Invalidate stale reads after a successful stake submission
    if (params.changeAddress && params.stakeCollectionId !== undefined) {
      await this.invalidateStakesCache(params.stakeCollectionId, params.changeAddress);
    }

    return response;
  }

  /**
   * Build an unsigned harvest (unstake / claim rewards) transaction.
   * NOT cached – depends on live UTxOs and validity interval.
   *
   * After a successful submission of the returned transaction, call
   * {@link invalidateStakesCache} to keep the read cache coherent.
   */
  async harvestStakeV2(params: {
    stakeId: number;
    changeAddress: string;
    utxos: string[];
    claim: boolean;
  }): Promise<HarvestStakeV2Response> {
    const payload = {
      stakeId: params.stakeId,
      changeAddress: params.changeAddress,
      utxos: params.utxos,
      claim: params.claim,
    };
    return this.makeRequest<HarvestStakeV2Response>('/harvestStakeV2', payload);
  }

  // ---------------------------------------------------------------------------
  // Cache invalidation
  // ---------------------------------------------------------------------------

  /**
   * Invalidate the getStakesV2 Redis entry for a specific treasury address.
   * Call this after any successful stake or harvest submission.
   */
  async invalidateStakesCache(stakeCollectionId: number, changeAddress: string): Promise<void> {
    const key = this.buildCacheKey('/getStakesV2', { stakeCollectionId, changeAddress });
    try {
      const deleted = await this.redis.del(key);
      this.logger.debug(
        `Invalidated getStakesV2 cache (${deleted ? 'hit' : 'miss'}) for address ${changeAddress.slice(0, 10)}…`
      );
    } catch (err) {
      this.logger.warn(`Failed to invalidate stakes cache: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Issue a POST request to Anvil, returning the result from Redis if a fresh
   * entry exists.  Redis failures are caught and the request is served live.
   */
  private async cachedRequest<T>(endpoint: string, payload: unknown, ttlSeconds: number): Promise<T> {
    const cacheKey = this.buildCacheKey(endpoint, payload);

    // --- cache read ---
    try {
      const raw = await this.redis.get(cacheKey);
      if (raw) {
        this.logger.debug(`Redis cache hit: ${endpoint}`);
        return JSON.parse(raw) as T;
      }
    } catch (err) {
      this.logger.warn(`Redis get failed for ${endpoint} – falling through to Anvil: ${(err as Error).message}`);
    }

    // --- live fetch ---
    const response = await this.makeRequest<T>(endpoint, payload);

    // --- cache write (best-effort) ---
    try {
      await this.redis.set(cacheKey, JSON.stringify(response), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis set failed for ${endpoint}: ${(err as Error).message}`);
    }

    return response;
  }

  /** Build a deterministic, namespaced Redis key for an endpoint + payload pair. */
  private buildCacheKey(endpoint: string, payload: unknown): string {
    const hash = createHash('sha256').update(stableStringify(payload)).digest('hex');
    return `${CACHE_PREFIX}:${endpoint.replace(/^\//, '')}:${hash}`;
  }

  /** Issue a plain (uncached) POST to an Anvil Firebase function endpoint. */
  private async makeRequest<T>(endpoint: string, payload: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anvil API ${endpoint} error: ${response.status} ${response.statusText} – ${errorText}`);
      }

      const data = (await response.json()) as any;

      if (data.success === false) {
        throw new Error(`Anvil API ${endpoint} returned success=false: ${JSON.stringify(data)}`);
      }

      return data as T;
    } catch (err) {
      this.logger.error(`Anvil API request to ${endpoint} failed: ${(err as Error).message}`, (err as Error).stack);
      throw err;
    }
  }
}
