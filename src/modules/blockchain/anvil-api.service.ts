import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NftAsset } from './vault-inserting.service';

interface AnvilApiConfig<T = Record<string, unknown>> {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PATCH';
  body?: T;
  params?: Record<string, string>;
}

interface BuildTransactionParams {
  changeAddress: string;
  txId: string;
  outputs: {
    address: string;
    lovelace?: number;
    assets?: NftAsset[];
  }[];
}

interface TransactionBuildResponse {
  hash: string;
  complete: string; // CBOR
  stripped: string; // CBOR
  witnessSet: string; // CBOR
}

@Injectable()
export class AnvilApiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('ANVIL_API_URL');
    this.apiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  async get<T>(endpoint: string, { params }: { params?: Record<string, string> } = {}): Promise<T> {
    return this.callAnvilApi({
      endpoint,
      method: 'GET',
      params
    });
  }

  async post<T, B>(endpoint: string, body: B): Promise<T> {
    return this.callAnvilApi({
      endpoint,
      method: 'POST',
      body
    });
  }

  async patch<T, B>(endpoint: string, body: B): Promise<T> {
    return this.callAnvilApi({
      endpoint,
      method: 'PATCH',
      body
    });
  }

  private async callAnvilApi<T, B = Record<string, unknown>>({
    endpoint,
    method = 'POST',
    body,
    params,
  }: AnvilApiConfig<B>): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('Anvil API base URL is not configured');
    }

    if (!this.apiKey) {
      throw new Error('API key is required for Anvil API');
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
    };

    try {
      const url = new URL(`${this.baseUrl}/${endpoint}`);
      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }

     // console.log('Base url ', this.baseUrl);
     // console.log('Method ', method);
     // console.log('Headers ', headers);
     // console.log('body ', JSON.stringify(body, null, 2) );
     // console.log('endpoint ', endpoint);

      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ message: 'Unknown error' }));
        throw new Error(
          `Anvil API Error (${response.status}): ${errorData.message || 'Unknown error'}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      console.error('Anvil API request failed:', error);
      throw error;
    }
  }

  async buildTransaction(params: BuildTransactionParams): Promise<TransactionBuildResponse> {
    const metadata = {
      txId: params.txId
    };

    return this.callAnvilApi({
      endpoint: 'services/transactions/build',
      body: {
        ...params,
        metadata
      },
    });
  }

  async submitTransaction(params: {
    transaction: string; // CBOR
    signatures?: string[]; // CBOR
  }): Promise<{
    txHash: string;
  }> {
    return this.callAnvilApi({
      endpoint: 'services/transactions/submit',
      body: params,
    });
  }
}
