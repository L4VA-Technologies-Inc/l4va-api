import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NftAsset } from './blockchain-transaction.service';

interface AnvilApiConfig<T = Record<string, unknown>> {
  endpoint: string;
  method?: 'GET' | 'POST';
  body?: T;
}

interface BuildTransactionParams {
  changeAddress: string;
  txId: string;
  outputs: {
    address: string;
    lovelace: number;
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

  async buildTransaction(params: BuildTransactionParams): Promise<TransactionBuildResponse> {
    const metadata = {
      txId: params.txId
    };

    // Transform outputs to match Anvil API format
    const transformedOutputs = params.outputs.map(output => ({
      address: output.address,
      lovelace: output.lovelace ?? 0, // Default to 0 if not provided
      assets: output.assets ? this.transformNftAssets(output.assets) : undefined
    }));

    return this.callAnvilApi({
      endpoint: 'services/transactions/build',
      body: {
        changeAddress: params.changeAddress,
        outputs: transformedOutputs,
        metadata
      },
    });
  }

  private transformNftAssets(assets: NftAsset[]): Record<string, number> {
    const result: Record<string, number> = {};
    
    for (const asset of assets) {
      // Format: policyId.assetName
      const assetId = `${asset.policyId}.${asset.assetName}`;
      result[assetId] = asset.quantity;
    }
    
    return result;
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
