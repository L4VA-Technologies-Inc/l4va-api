export enum OnchainTransactionStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  NOT_FOUND = 'not_found',
}

export interface TransactionBuildResponse {
  complete: string;
  partial: string;
}

export interface WayUpTransactionBuildResponse {
  transactions: string[];
  distribution: Array<{
    buy: number[];
    acceptTrade: number[];
    unlistTrade: number[];
    unlist: number[];
    unlistOffer: number[];
    unlistCollectionOffer: number[];
    acceptOffer: number[];
    acceptCollectionOffer: number[];
    migrate: number[];
    update: number[];
    updateTrade: number[];
    create: number[];
    createTrade: number[];
    createCollectionOffer: number[];
    createOffer: number[];
  }>;
}

export interface TransactionSubmitResponse {
  txHash: string;
}

export interface ApplyParamsPayload {
  params: Record<string, any[]>;
  blueprint: {
    title: string;
    version: string;
  };
}

export interface ApplyParamsResponse {
  preloadedScript: {
    blueprint: {
      preamble: any;
      validators: Array<{
        title: string;
        hash: string;
      }>;
    };
  };
}

export interface UploadBlueprintPayload {
  blueprint: {
    preamble: any;
    validators: any[];
  };
  refs?: Record<string, { txHash: string; index: number }>;
}

export interface NftAsset {
  policyId: string;
  assetName: string;
  quantity: number;
}

export interface BuildTransactionOutput {
  address?: string;
  lovelace?: number;
  assets?: NftAsset[];
}

export interface BuildTransactionParams {
  changeAddress: string;
  txId: string;
  outputs: BuildTransactionOutput[];
}

export interface SubmitTransactionParams {
  transaction: string; // CBOR encoded transaction
  vaultId: string;
  signatures?: string[]; // Optional array of signatures
}

export interface ContributionTransactionBuildResponse {
  hash: string;
  complete: string; // CBOR encoded complete transaction
  stripped: string; // CBOR encoded stripped transaction
  witnessSet: string; // CBOR encoded witness set
}
