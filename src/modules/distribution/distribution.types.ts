import { Datum, Datum1 } from '../vaults/processing-tx/onchain/types/type';

export interface TransactionInput {
  changeAddress: string;
  message: string;
  utxos: string[];
  mint: MintAsset[];
  scriptInteractions: ScriptInteraction[];
  outputs: TransactionOutput[];
  requiredSigners: string[];
  referenceInputs: ReferenceInput[];
  validityInterval: ValidityInterval;
  network: string;
}

export interface VaultCreationInput {
  changeAddress: string;
  message: string;
  utxos: string[];
  mint: MintAsset[];
  scriptInteractions: ScriptInteraction[];
  outputs: (
    | {
        address: string;
        assets: AssetOutput[];
        datum: { type: 'inline'; value: Datum1; shape: object };
      }
    | {
        address: string;
        datum: { type: 'script'; hash: string };
      }
    // VLRM Fee
    | {
        address: string;
        assets: AssetOutput[];
      }
  )[];
  requiredInputs: string[];
}

export interface CancellationInput {
  changeAddress: string;
  message: string;
  utxos: string[];
  mint?: MintAsset[];
  scriptInteractions: ScriptInteraction[];
  outputs: {
    address: string;
    assets?: AssetOutput[];
    lovelace?: number;
    datum?: { type: 'inline'; value: string | Datum; shape?: object };
  }[];
  requiredSigners: string[];
  referenceInputs: { txHash: string; index: number }[];
  validityInterval: ValidityInterval;
  network: string;
}

export interface PayAdaContributionInput extends TransactionInput {
  preloadedScripts: object[];
}

export interface ContributionInput {
  changeAddress: string;
  utxos: string[];
  message: string;
  mint: object[];
  scriptInteractions: object[];
  outputs: (
    | {
        address: string;
        assets?: object[];
        lovelace?: number; // Required if Contribution in ADA
        datum?: { type: 'inline'; value: Datum; shape: object };
      }
    // Fee output
    | {
        address: string;
        lovelace: number;
      }
  )[];
  requiredSigners: string[];
  requiredInputs?: string[];
  referenceInputs: { txHash: string; index: number }[];
  validityInterval: {
    start: boolean;
    end: boolean;
  };
  network: string;
}

export interface ExtractInput extends TransactionInput {
  deposits?: {
    hash: string;
    type: string;
    deposit: string;
  }[];
}

export interface TransactionOutput {
  address: string;
  assets?: AssetOutput[];
  lovelace?: number;
  datum?: InlineDatum;
}

export interface AssetOutput {
  assetName: { name: string; format: string };
  policyId: string;
  quantity: number;
}

export interface InlineDatum {
  type: 'inline';
  value: any;
  shape?: DatumShape;
}

export interface DatumShape {
  validatorHash: string;
  purpose: 'spend' | 'mint' | 'withdraw';
}

export interface ScriptInteraction {
  purpose: 'spend' | 'mint' | 'withdraw';
  hash: string;
  outputRef?: OutputReference;
  redeemer: Redeemer;
}

export interface OutputReference {
  txHash: string;
  index: number;
}

export interface Redeemer {
  type: 'json';
  value: any;
}

export interface ReferenceInput {
  txHash: string;
  index: number;
}

export interface ValidityInterval {
  start: boolean;
  end: boolean;
}

export interface MintAsset {
  version: string;
  assetName: { name: string; format: string };
  policyId: string;
  type: string;
  quantity: number;
  metadata: Record<string, any>;
}

export interface AddressesUtxo {
  address: string;
  tx_hash: string;
  tx_index: number;
  output_index: number;
  amount: {
    unit: string;
    quantity: string;
  }[];
  block: string;
  data_hash: string;
  inline_datum: string;
  reference_script_hash: string;
}

export interface UtxoSelection {
  selectedUtxos: AddressesUtxo[];
  totalAmount: number;
}

export interface BatchSizeResult {
  optimalBatchSize: number;
  actualClaims: any[];
}

export interface DispatchParameters {
  parameterizedHash: string;
  fullResponse: any;
}
