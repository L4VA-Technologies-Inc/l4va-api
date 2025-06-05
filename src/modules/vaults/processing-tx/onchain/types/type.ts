export type Redeemer =
  | {
      quantity: number
      output_index: number
      contribution: 'Lovelace' | 'Asset'
    }
  | 'MintAdaPair'
  | 'BurnLp'
export type Redeemer1 =
  | {
      __variant: 'ExtractAda' | 'ExtractAsset'
      __data: {
        lp_output_index?: number
      }
    }
  | {
      lp_output_index: number
      change_output_index: number
    }
  | 'CancelAsset'
  | 'CancelAda'
export type Redeemer2 =
  | {
      vault_token_index: number
      asset_name: string
    }
  | 'VaultBurn'
export type Redeemer3 =
  | {
      vault_token_index: number
      asset_name: string
    }
  | 'VaultBurn'

/**
 * Aiken contracts for project 'l4va/vault'
 */
export interface L4VaVault {
  contribute: {
    mint: {
      redeemer: Redeemer
    }
    spend: {
      redeemer: Redeemer1
      datum: Datum
    }
    else: {
      redeemer: unknown
    }
  }
  vault: {
    mint: {
      redeemer: Redeemer2
    }
    spend: {
      redeemer: Redeemer3
      datum: Datum1
    }
    else: {
      redeemer: unknown
    }
  }
}
export interface Datum {
  policy_id: string
  asset_name: string
  quantity: number
  owner:
    | string
    | {
        payment_credential: {
          __variant: 'VerificationKey' | 'Script'
          __data: string
        }
        stake_credential?:
          | {
              __variant: 'VerificationKey' | 'Script'
              __data: string
            }
          | {
              slot_number: number
              transaction_index: number
              certificate_index: number
            }
      }
  datum_tag?: string
  contributed_assets?: Array<{
    policy_id: string
    asset_name: string
    quantity: number
  }>
}
export interface Datum1 {
  contract_type: number
  asset_whitelist: string[]
  contributor_whitelist?: string[]
  asset_window: {
    lower_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity'
      is_inclusive: boolean
    }
    upper_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity'
      is_inclusive: boolean
    }
  }
  investment_window: {
    lower_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity'
      is_inclusive: boolean
    }
    upper_bound: {
      bound_type: 'NegativeInfinity' | number | 'PositiveInfinity'
      is_inclusive: boolean
    }
  }
  valuation_type: number
  fractionalization?: {
    percentage: number
    token_supply: number
    token_decimals: number
    token_policy: string
  }
  custom_metadata: [string, string, ...string[]][]
  termination?: {
    termination_type: number
    fdp: number
  }
  investment?: {
    reserve: number
    liquidityPool: number
  }
  admin: string
  minting_key: string
}
