import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NexusPool } from './interfaces/nexus.interface';

/**
 * Nexus API client for DEX pool data with API key authentication
 *
 * Provides LP token unit resolution for pools discovered via DexHunter.
 * Uses X-Api-Key header for authentication.
 */
@Injectable()
export class NexusClient {
  private readonly logger = new Logger(NexusClient.name);
  private readonly isMainnet: boolean;
  private readonly nexusApiUrl: string;
  private readonly nexusApiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.nexusApiUrl = this.configService.get<string>('NEXUS_API_URL') || 'https://nexus.gerowallet.io';
    this.nexusApiKey = this.configService.get<string>('NEXUS_API_KEY') || '';

    if (!this.nexusApiKey) {
      this.logger.warn('Nexus API key not configured. Pool resolution will be limited.');
    }
  }

  /**
   * Get pool details by pool ID
   * @param poolId Nexus pool identifier (e.g., "minswap_v2_abc123...")
   * @returns Pool data including LP token unit and total supply, or null if not found
   */
  async getPoolById(poolId: string): Promise<NexusPool | null> {
    // Skip for non-mainnet (Nexus may not support testnet/preprod)
    if (!this.isMainnet) {
      this.logger.debug(`Skipping Nexus API call for non-mainnet environment`);
      return null;
    }

    // Skip if API key not configured
    if (!this.nexusApiKey) {
      this.logger.debug(`Skipping Nexus API call - API key not configured`);
      return null;
    }

    try {
      const response = await fetch(`${this.nexusApiUrl}/api/dex/pools/${poolId}`, {
        headers: {
          'X-Api-Key': this.nexusApiKey,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 404) {
        // Pool not found - this is expected for some pool IDs
        this.logger.debug(`Pool not found in Nexus: ${poolId}`);
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const pool: NexusPool = await response.json();
      return pool;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch pool from Nexus (${poolId}): ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
}
