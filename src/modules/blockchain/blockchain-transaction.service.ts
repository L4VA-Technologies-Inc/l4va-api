import { Injectable } from '@nestjs/common';
import { AnvilApiService } from './anvil-api.service';
import { TransactionsService } from '../transactions/transactions.service';

export interface BuildTransactionParams {
  changeAddress: string;
  txId: string; // Outchain transaction ID
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
  constructor(
    private readonly anvilApiService: AnvilApiService,
    private readonly transactionsService: TransactionsService
  ) {}

  async buildTransaction(params: BuildTransactionParams): Promise<TransactionBuildResponse> {
    const result = await this.anvilApiService.buildTransaction(params);
    
    // Update the outchain transaction with the onchain transaction hash
    await this.transactionsService.updateTransactionHash(params.txId, result.hash);
    
    return result;
  }

  async submitTransaction(params: SubmitTransactionParams): Promise<TransactionSubmitResponse> {
    return this.anvilApiService.submitTransaction(params);
  }
}
