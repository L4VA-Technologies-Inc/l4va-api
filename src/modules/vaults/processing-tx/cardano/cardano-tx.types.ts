export type Redeemer =
  | {
      output_index: number;
      contribution: 'Lovelace' | 'Asset';
    }
  | 'MintVaultToken'
  | 'CancelContribution'
  | 'BurnLp';
export type VaultPolicy = string;
export type VaultId = string;
export type Redeemer1 =
  | {
      __variant: 'ExtractAda' | 'ExtractAsset';
      __data: {
        vault_token_output_index?: number;
      };
    }
  | {
      vault_token_output_index: number;
      change_output_index: number;
    }
  | {
      __variant: 'CancelAsset' | 'CancelAda';
      __data: {
        cancel_output_index?: number;
      };
    };
type VaultPolicy1 = string;
type VaultId1 = string;
type VaultPolicy2 = string;
type VaultId2 = string;
export type Redeemer2 =
  | {
      vault_token_index: number;
      asset_name: string;
    }
  | 'VaultBurn';
export type Redeemer3 =
  | {
      vault_token_index: number;
      asset_name: string;
    }
  | 'VaultBurn';

/**
 * Aiken contracts for project 'l4va/vault'
 */
export interface L4VaVault {
  contribute: {
    mint: {
      redeemer: Redeemer;
      parameters: [] | [VaultPolicy] | [VaultPolicy, VaultId];
    };
    spend: {
      redeemer: Redeemer1;
      datum: Datum;
      parameters: [] | [VaultPolicy1] | [VaultPolicy1, VaultId1];
    };
    else: {
      redeemer: unknown;
      parameters: [] | [VaultPolicy2] | [VaultPolicy2, VaultId2];
    };
  };
  vault: {
    mint: {
      redeemer: Redeemer2;
    };
    spend: {
      redeemer: Redeemer3;
      datum: Datum1;
    };
    else: {
      redeemer: unknown;
    };
  };
}
export interface Datum {
  policy_id: string;
  asset_name: string;
  owner:
    | string
    | {
        payment_credential: {
          __variant: 'VerificationKey' | 'Script';
          __data: string;
        };
        stake_credential?:
          | {
              __variant: 'VerificationKey' | 'Script';
              __data: string;
            }
          | {
              slot_number: number;
              transaction_index: number;
              certificate_index: number;
            };
      };
  datum_tag?: string;
  ada_paid?: number;
}
export interface Datum1 {
  vault_status: 0 | 1 | 2 | 3; // 0: contribution, 1: launch, 2: distribution, 3: closed
  contract_type: number;
  asset_whitelist: string[];
  contributor_whitelist?: string[];
  asset_window: {
    lower_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity';
      is_inclusive: boolean;
    };
    upper_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity';
      is_inclusive: boolean;
    };
  };
  acquire_window: {
    lower_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity';
      is_inclusive: boolean;
    };
    upper_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity';
      is_inclusive: boolean;
    };
  };
  valuation_type: number;
  fractionalization?: {
    percentage: number;
    token_supply: number;
    token_decimals: number;
    token_policy: string;
  };
  custom_metadata: [string, string, ...string[]][];
  termination?: {
    termination_type: number;
    fdp: number;
  };
  acquire?: {
    reserve: number;
    liquidityPool: number;
  };
  acquire_multiplier?: [string, string | undefined, number][];
  ada_distribution?: [string, string | undefined, number][];
  ada_pair_multipler?: number;
  admin: string;
  minting_key: string;
}
