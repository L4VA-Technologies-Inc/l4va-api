export interface BlockchainTransactionResponse {
  hash: string;
  block: string;
  block_height?: number;
  valid_contract: boolean;
  timestamp: string;
  inputs: {
    address: string;
    amount: string;
    assets?: Array<{
      policyId: string;
      assetName: string;
      amount: string;
    }>;
  }[];
  outputs: {
    address: string;
    amount: string;
    assets?: Array<{
      policyId: string;
      assetName: string;
      amount: string;
    }>;
  }[];
}

export interface BlockchainAddressResponse {
  address: string;
  balance: string;
  assets?: Array<{
    policyId: string;
    assetName: string;
    amount: string;
  }>;
}

export interface BlockchainContractResponse {
  address: string;
  state: Record<string, unknown>;
  lastUpdate: string;
}

export interface BlockchainTokenResponse {
  policyId: string;
  assetName: string;
  totalSupply: string;
  metadata?: Record<string, unknown>;
}
