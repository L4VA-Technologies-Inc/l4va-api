import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface AnvilApiConfig<T = Record<string, unknown>> {
  endpoint: string;
  method?: 'GET' | 'POST';
  body?: T;
}

@Injectable()
export class AnvilApiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('ANVIL_API_URL');
    this.apiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  private async callAnvilApi<T, B = Record<string, unknown>>({
    endpoint,
    method = 'POST',
    body,
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
      const response = await fetch(`${this.baseUrl}/${endpoint}`, {
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

  async buildTransaction(params: {
    changeAddress: string;
    utxos: string[];
    outputs: {
      address: string;
      lovelace: number;
      assets?: Record<string, number>;
    }[];
  }): Promise<{
    hash: string;
    complete: string; // CBOR
    stripped: string; // CBOR
    witnessSet: string; // CBOR
  }> {
    return this.callAnvilApi({
      endpoint: 'services/transactions/build',
      body: params,
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
