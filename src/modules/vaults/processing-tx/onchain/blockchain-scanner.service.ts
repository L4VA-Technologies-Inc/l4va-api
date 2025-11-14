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
    payload:
      | {
          address: string;
        }
      | Record<string, any>
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

  async registerTrackingAddress(vaultAddress: string = '', vaultName: string): Promise<any> {
    let retries = 0;
    const maxRetries = 5;
    const retryDelay = 20000;

    while (retries < maxRetries) {
      try {
        return await this.makePostRequest(`/monitoring/addresses`, {
          address: vaultAddress,
          name: vaultName,
          description: 'Monitoring vault address',
        });
      } catch (error) {
        retries++;
        this.logger.warn(
          `Failed to register tracking address ${vaultAddress}. Attempt ${retries}/${maxRetries}. Retrying in 20 seconds...`
        );

        if (retries >= maxRetries) {
          this.logger.error(`Max retries reached for registering address ${vaultAddress}`);
          throw error;
        }

        await setTimeout(retryDelay);
      }
    }
  }

  async checkMonitoringAddress(vaultAddress: string = '', vaultName: string = ''): Promise<boolean> {
    try {
      // First, check if the address is already being monitored
      const response = await this.makeRequest<
        {
          id: string;
          address: string;
          name: string;
          description: string;
          last_checked_at: string;
          created_at: string;
          is_active: boolean;
        }[]
      >(`/monitoring/addresses`);
      if (response && response.some((addr: any) => addr.address === vaultAddress)) {
        this.logger.log(`Address ${vaultAddress} is already being monitored`);
        return true;
      } else {
        this.logger.log(`Address ${vaultAddress} is not being monitored`);
        await this.registerTrackingAddress(vaultAddress, vaultName);
      }
    } catch {
      this.logger.error(`Address ${vaultAddress} is not registered`);
      return false;
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
