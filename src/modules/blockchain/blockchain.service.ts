import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export enum OnchainTransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  NOT_FOUND = 'not_found'
}

export interface TransactionBuildResponse {
  complete: string;
  partial: string;
}

export interface TransactionSubmitResponse {
  txHash: string;
}

@Injectable()
export class BlockchainService {
  private readonly logger = new Logger(BlockchainService.name);
  private readonly anvilApi: string;
  private readonly anvilApiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  /**
   * Builds a transaction using Anvil API
   * @param txData Transaction data to be built
   * @returns Object containing complete and partial transaction CBOR
   */
  async buildTransaction(txData: any): Promise<TransactionBuildResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<TransactionBuildResponse>(
          `${this.anvilApi}/transactions/build`,
          txData,
          {
            headers: {
              'x-api-key': this.anvilApiKey,
              'Content-Type': 'application/json',
            },
          }
        )
      );

      if (!response.data.complete) {
        throw new Error('Failed to build complete transaction');
      }

      return response.data;
    } catch (error) {
      this.logger.error('Error building transaction', error);
      throw new Error(`Failed to build transaction: ${error.message}`);
    }
  }

  /**
   * Submits a signed transaction to the blockchain
   * @param signedTx Signed transaction data
   * @returns Transaction hash
   */
  async submitTransaction(signedTx: {
    transaction: string;
    signatures?: string[];
  }): Promise<TransactionSubmitResponse> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ txHash: string }>(
          `${this.anvilApi}/transactions/submit`,
          {
            transaction: signedTx.transaction,
            signatures: signedTx.signatures || [],
          },
          {
            headers: {
              'x-api-key': this.anvilApiKey,
              'Content-Type': 'application/json',
            },
          }
        )
      );

      if (!response.data.txHash) {
        throw new Error('No transaction hash returned from blockchain');
      }

      this.logger.log(`Transaction submitted successfully: ${response.data.txHash}`);
      return { txHash: response.data.txHash };
    } catch (error) {
      this.logger.error('Error submitting transaction', error);
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }
}
