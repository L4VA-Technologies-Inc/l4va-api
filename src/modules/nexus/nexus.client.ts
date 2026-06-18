import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NexusAuthResponse, NexusPool } from './interfaces/nexus.interface';

/**
 * Nexus API client for DEX pool data with JWT authentication
 *
 * Provides LP token unit resolution for pools discovered via DexHunter.
 * Handles automatic token refresh before expiry (1-hour lifespan with 1-minute buffer).
 */
@Injectable()
export class NexusClient {
  private readonly logger = new Logger(NexusClient.name);
  private readonly isMainnet: boolean;
  private readonly nexusApiUrl: string;
  private readonly nexusEmail: string;
  private readonly nexusPassword: string;

  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry: number | null = null;

  constructor(private readonly configService: ConfigService) {
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';
    this.nexusApiUrl = this.configService.get<string>('NEXUS_API_URL') || 'https://nexus.gerowallet.io';
    this.nexusEmail = this.configService.get<string>('NEXUS_API_EMAIL') || '';
    this.nexusPassword = this.configService.get<string>('NEXUS_API_PASSWORD') || '';

    if (!this.nexusEmail || !this.nexusPassword) {
      this.logger.warn('Nexus API credentials not configured. Pool resolution will be limited.');
    }
  }

  /**
   * Authenticate with Nexus API and store tokens
   * @throws Error if authentication fails
   */
  private async authenticate(): Promise<void> {
    try {
      const response = await fetch(`${this.nexusApiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.nexusEmail,
          password: this.nexusPassword,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Authentication failed: ${response.status} - ${errorText}`);
      }

      const data: NexusAuthResponse = await response.json();
      this.setTokens(data);
      this.logger.log('Successfully authenticated with Nexus API');
    } catch (error) {
      this.logger.error(`Failed to authenticate with Nexus: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Store authentication tokens with expiry tracking
   * @param data Authentication response from Nexus
   */
  private setTokens(data: NexusAuthResponse): void {
    this.accessToken = data.accessToken;
    this.refreshToken = data.refreshToken;
    // Set expiry with 1-minute buffer (3600000ms - 60000ms = 3540000ms)
    this.tokenExpiry = Date.now() + data.expiresIn - 60000;
  }

  /**
   * Refresh the access token using the refresh token
   * @throws Error if refresh fails
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      this.logger.warn('No refresh token available, re-authenticating');
      await this.authenticate();
      return;
    }

    try {
      const response = await fetch(`${this.nexusApiUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!response.ok) {
        // Refresh token expired or invalid - re-authenticate
        this.logger.warn('Refresh token expired, re-authenticating');
        await this.authenticate();
        return;
      }

      const data: NexusAuthResponse = await response.json();
      this.setTokens(data);
      this.logger.debug('Successfully refreshed Nexus access token');
    } catch (error) {
      this.logger.error(`Failed to refresh token: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback to re-authentication
      await this.authenticate();
    }
  }

  /**
   * Ensure we have a valid access token (authenticate or refresh if needed)
   */
  private async ensureValidToken(): Promise<void> {
    // No token yet - authenticate
    if (!this.tokenExpiry || !this.accessToken) {
      await this.authenticate();
      return;
    }

    // Token expired or about to expire - refresh
    if (Date.now() >= this.tokenExpiry) {
      await this.refreshAccessToken();
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

    // Skip if credentials not configured
    if (!this.nexusEmail || !this.nexusPassword) {
      this.logger.debug(`Skipping Nexus API call - credentials not configured`);
      return null;
    }

    try {
      await this.ensureValidToken();

      const response = await fetch(`${this.nexusApiUrl}/api/dex/pools/${poolId}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 404) {
        // Pool not found - this is expected for some pool IDs
        this.logger.debug(`Pool not found in Nexus: ${poolId}`);
        return null;
      }

      if (response.status === 401) {
        // Token might have expired between check and request - retry once
        this.logger.warn('Received 401 from Nexus, re-authenticating and retrying');
        await this.authenticate();

        const retryResponse = await fetch(`${this.nexusApiUrl}/api/dex/pools/${poolId}`, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!retryResponse.ok) {
          throw new Error(`Retry failed: ${retryResponse.status}`);
        }

        return await retryResponse.json();
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const pool: NexusPool = await response.json();
      return pool;
    } catch (error) {
      this.logger.error(
        `Failed to fetch pool from Nexus (${poolId}): ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Clear authentication state (useful for testing)
   */
  clearAuth(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.logger.debug('Cleared Nexus authentication state');
  }
}
