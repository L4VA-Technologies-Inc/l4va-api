import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  BlockchainTransactionResponse,
  BlockchainAddressResponse,
  BlockchainContractResponse,
  BlockchainTokenResponse
} from '../../types/blockchain.types';

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
    this.logger.log('URL AND key ', this.scannerKey, this.scannerUrl);
    try {
      const response = await axios.get(`${this.scannerUrl}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${this.scannerKey}`
        }
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Scanner request failed for ${endpoint}:`, error);
      throw error;
    }
  }

  async getAddressBalance(address: string): Promise<BlockchainAddressResponse> {
    return this.makeRequest(`/blockchain/addresses/${address}/balance`);
  }

  async getAddressTransactions(address: string): Promise<BlockchainTransactionResponse[]> {
    return this.makeRequest(`/blockchain/addresses/${address}/transactions`);
  }

  async getAddressUtxos(address: string): Promise<BlockchainAddressResponse> {
    return this.makeRequest(`/blockchain/addresses/${address}/utxos`);
  }

  async getTransactionDetails(txHash: string): Promise<BlockchainTransactionResponse> {
    return this.makeRequest(`/blockchain/transactions/${txHash}`);
  }

  async getContractState(contractAddress: string): Promise<BlockchainContractResponse> {
    return this.makeRequest(`/blockchain/contracts/${contractAddress}/state`);
  }

  async getTokenInfo(policyId: string, assetName: string): Promise<BlockchainTokenResponse> {
    return this.makeRequest(`/blockchain/tokens/${policyId}/${assetName}`);
  }
}
