import { setTimeout } from 'timers/promises';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import {
  BlockchainTransactionResponse,
  BlockchainAddressResponse,
  BlockchainContractResponse,
  BlockchainTokenResponse,
  BlockchainTransactionListResponse,
  BlockchainTransactionListItem,
} from '../../../../types/blockchain.types';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 2000; // 2 seconds
const DEFAULT_MAX_DELAY_MS = 30000; // 30 seconds

@Injectable()
export class BlockchainScannerService {
  private readonly logger = new Logger(BlockchainScannerService.name);
  private readonly scannerUrl: string;
  private readonly scannerKey: string;

  constructor(private readonly configService: ConfigService) {
    this.scannerUrl = this.configService.get<string>('SCANNER_URL');
    this.scannerKey = this.configService.get<string>('SCANNER_KEY');
  }

  private async makeRequest<T>(endpoint: string): Promise<T> {
    this.logger.log(`Scanner URL ${this.scannerUrl}${endpoint}`);
    // this.logger.log(`Scanner KEY ${this.scannerKey}`);
    try {
      const response = await axios.get(`${this.scannerUrl}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.scannerKey}`,
        },
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Scanner request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  private async makePostRequest<T>(
    endpoint: string,
    payload: {
      address: string;
    }
  ): Promise<T> {
    try {
      const response = await axios.post(
        `${this.scannerUrl}${endpoint}`,
        {
          ...payload,
        },
        {
          headers: {
            Authorization: `Bearer ${this.scannerKey}`,
          },
        }
      );
      return response.data;
    } catch (error) {
      this.logger.error(`Scanner request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  async registerTrackingAddress(vaultAddress: string = '', vaultName: string) {
    const payload = {
      address: vaultAddress,
      name: vaultName,
      description: 'Monitoring vault address',
    };
    return this.makePostRequest(`/monitoring/addresses`, payload);
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
      shouldRetry?: (error: Error) => boolean;
    } = {}
  ): Promise<T> {
    const {
      maxRetries = DEFAULT_MAX_RETRIES,
      initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
      maxDelayMs = DEFAULT_MAX_DELAY_MS,
      shouldRetry = () => true,
    } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (attempt === maxRetries || !shouldRetry(error as Error)) {
          throw lastError;
        }

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = Math.random() * baseDelay * 0.2; // Add up to 20% jitter
        const delay = Math.min(baseDelay + jitter, maxDelayMs);

        this.logger.warn(`Attempt ${attempt + 1}/${maxRetries} failed. Retrying in ${Math.round(delay)}ms...`, {
          error: error.message,
        });

        await setTimeout(delay);
      }
    }

    // This should never be reached due to the throw in the catch block,
    // but TypeScript needs this to be here
    throw lastError || new Error('Unknown error in withRetry');
  }

  private isRetryableError(error: Error): boolean {
    // Retry on network errors or 5xx server errors
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      return !status || status >= 500;
    }
    return true; // Retry on other errors by default
  }

  async checkMonitoringAddress(vaultAddress: string = '', vaultName: string = ''): Promise<boolean> {
    try {
      // First, check if the address is already being monitored
      const response: {
        id: string;
        address: string;
        name: string;
        description: string;
        last_checked_at: string;
        created_at: string;
        is_active: boolean;
      }[] = await this.makeRequest(`/monitoring/addresses`);
      if (response && response.some((addr: any) => addr.address === vaultAddress)) {
        this.logger.log(`Address ${vaultAddress} is already being monitored`);
        return true;
      } else {
        this.logger.log(`Address ${vaultAddress} is not being monitored`);
        await this.registerTrackingAddress(vaultAddress, vaultName);
      }
    } catch (error) {
      if (!vaultName) {
        return false;
      }

      this.logger.log(`Address ${vaultAddress} is not registered, attempting to register...`);

      try {
        await this.withRetry(() => this.registerTrackingAddress(vaultAddress, vaultName), {
          shouldRetry: err => {
            // Only retry on network or server errors
            return this.isRetryableError(err);
          },
        });
        this.logger.log(`Successfully registered address ${vaultAddress} for monitoring`);
        return true;
      } catch (error) {
        this.logger.error(`Failed to register address ${vaultAddress} for monitoring after retries`, error);
        return false;
      }
    }
  }

  async getAddressBalance(address: string): Promise<BlockchainAddressResponse> {
    return this.makeRequest(`/blockchain/addresses/${address}/balance`);
  }

  async getAddressTransactions(address: string): Promise<BlockchainTransactionListItem[]> {
    const response = await this.makeRequest<BlockchainTransactionListResponse>(
      `/blockchain/addresses/${address}/transactions`
    );
    return response?.transactions || [];
  }

  async getTransactionDetails(txHash: string): Promise<BlockchainTransactionResponse> {
    return this.makeRequest(`/blockchain/transactions/${txHash}`);
  }

  async getAddressUtxos(address: string): Promise<BlockchainAddressResponse> {
    return this.makeRequest(`/blockchain/addresses/${address}/utxos`);
  }

  async getContractState(contractAddress: string): Promise<BlockchainContractResponse> {
    return this.makeRequest(`/blockchain/contracts/${contractAddress}/state`);
  }

  async getTokenInfo(policyId: string, assetName: string): Promise<BlockchainTokenResponse> {
    return this.makeRequest(`/blockchain/tokens/${policyId}/${assetName}`);
  }
}
