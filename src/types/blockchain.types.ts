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
  output_amount?: {unit: string; quantity: string }[];
  metadata?: any;
}

export interface Asset {
  unit: string;
  quantity: string;
}

export interface BlockchainUtxo {
  address: string;
  tx_hash: string;
  tx_index: number;
  output_index: number;
  amount: Asset[];
  block: string;
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
}

export interface BlockchainAddressResponse {
  address: string;
  utxo_count: number;
  utxos: BlockchainUtxo[];
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
