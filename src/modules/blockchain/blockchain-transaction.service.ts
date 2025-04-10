import { Injectable } from '@nestjs/common';
import { AnvilApiService } from './anvil-api.service';

export interface BuildTransactionParams {
  changeAddress: string;
  utxos: string[];
  outputs: {
    address: string;
    lovelace: number;
    assets?: Record<string, number>;
  }[];
}

export interface SubmitTransactionParams {
  transaction: string; // CBOR encoded transaction
  signatures?: string[]; // Optional array of signatures
}

export interface TransactionBuildResponse {
  hash: string;
  complete: string; // CBOR encoded complete transaction
  stripped: string; // CBOR encoded stripped transaction
  witnessSet: string; // CBOR encoded witness set
}

export interface TransactionSubmitResponse {
  txHash: string;
}

@Injectable()
export class BlockchainTransactionService {
  constructor(private readonly anvilApiService: AnvilApiService) {}

  async buildTransaction(params: BuildTransactionParams): Promise<TransactionBuildResponse> {
    return this.anvilApiService.buildTransaction(params);
  }

  async submitTransaction(params: SubmitTransactionParams): Promise<TransactionSubmitResponse> {
    return this.anvilApiService.submitTransaction(params);
  }
}
