import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  Address,
  FixedTransaction, PrivateKey,
} from '@emurgo/cardano-serialization-lib-nodejs';
import {Datum1} from './types/type';
import {generate_assetname_from_txhash_index, getUtxos, toHex} from './utils/lib';
import {Buffer} from 'node:buffer';

interface TimeWindow {
  lower_bound: {
    bound_type: number;
    is_inclusive: boolean;
  };
  upper_bound: {
    bound_type: number;
    is_inclusive: boolean;
  };
}

interface VaultDatum {
  contract_type: number; // 0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE
  asset_whitelist: string[];
  asset_window: TimeWindow;
  investment_window: TimeWindow;
  valuation_type: number; // 0: FIXED | 1: LBE
  custom_metadata: [string, string][];
  admin: string;
  minting_key: string;
}

interface AssetConfig {
  assetName: {
    name: string;
    format: 'hex';
  };
  policyId: string;
  quantity: number;
}

interface ScriptInteraction {
  purpose: 'mint';
  hash: string;
  redeemer: {
    type: 'json';
    value: {
      vault_token_index: number;
      asset_name: string;
    };
  };
}

interface MintConfig extends AssetConfig {
  version: 'cip25';
  type: 'plutus';
  metadata: Record<string, unknown>;
}

interface CreateVaultRequest {
  changeAddress: string;
  message: string;
  mint: MintConfig[];
  scriptInteractions: ScriptInteraction[];
  outputs: {
    address: string;
    assets: AssetConfig[];
    datum: {
      type: 'inline';
      value: VaultDatum;
      shape: {
        validatorHash: string;
        purpose: 'spend';
      };
    };
  }[];
  requiredInputs: string[];
}

interface CreateVaultResponse {
  txHash: string;
  vaultId: string;
}

interface UpdateVaultResponse {
  txHash: string;
}

interface ClaimVaultResponse {
  txHash: string;
}

interface VaultResponse {
  vaultId: string;
  owner: string;
  beneficiary: string;
  unlockTime: number;
  tokenAmount: string;
  status: 'active' | 'unlocked' | 'claimed';
  policyId?: string;
  assetName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultConfig {
  vaultName: string;
  customerAddress: string;
  adminKeyHash: string;
  policyId: string;
  allowedPolicies: string[];
  assetWindow?: {
    start: number;
    end: number;
  };
  investmentWindow?: {
    start: number;
    end: number;
  };
  contractType?: number; // 0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE
  valuationType?: number; // 0: FIXED | 1: LBE
  customMetadata?: [string, string][];
}

export interface VaultMetadata {
  vaultId: string;
  owner: string;
  beneficiary: string;
  unlockTime: number;
  tokenAmount: string;
  status: 'active' | 'unlocked' | 'claimed';
  policyId?: string;
  assetName?: string;
  createdAt: number;
  updatedAt: number;
}

const one_day = 24 * 60 * 60 * 1000;


@Injectable()
export class VaultContractService {
  private readonly logger = new Logger(VaultContractService.name);
  private  scAddress: string;
  private readonly anvilApi: string;
  private readonly anvilApiKey: string;
  private readonly scPolicyId: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;
  constructor(
    private readonly configService: ConfigService
  ) {
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY');
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
  }

  /**
   * Create a new vault with the specified configuration
   * @param config Vault configuration parameters
   * @returns Transaction hash and vault ID
   */
  async createOnChainVaultTx(vaultConfig: VaultConfig): Promise<any> {

    this.scAddress = EnterpriseAddress.new(
      0,
      Credential.from_scripthash(ScriptHash.from_hex(this.scPolicyId)),
    )
      .to_address()
      .to_bech32();

    const utxos = await getUtxos(Address.from_bech32(vaultConfig.customerAddress)); // Any UTXO works.
    if (utxos.len() === 0) {
      throw new Error('No UTXOs found.');
    }

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];
    const assetName = generate_assetname_from_txhash_index(
      selectedUtxo.input().transaction_id().to_hex(),
      selectedUtxo.input().index(),
    );

    try {
      const input: {
        changeAddress: string;
        message: string;
        mint: Array<object>;
        scriptInteractions: object[];
        outputs: {
          address: string;
          assets: object[];
          datum: { type: 'inline'; value: Datum1; shape: object };
        }[];
        requiredInputs: string[];
      } = {
        changeAddress: vaultConfig.customerAddress,
        message: vaultConfig.vaultName,
        mint: [
          {
            version: 'cip25',
            assetName: {name: assetName, format:'hex'},
            policyId: this.scPolicyId,
            type: 'plutus',
            quantity: 1,
            metadata: {},
          },
        ],
        scriptInteractions: [
          {
            purpose: 'mint',
            hash: this.scPolicyId,
            redeemer: {
              type: 'json',
              value: {
                vault_token_index: 0,
                asset_name: assetName,
              },
            },
          },
        ],
        outputs: [
          {
            address: this.scAddress,
            assets: [
              {
                assetName: {name:assetName, format:'hex'},
                policyId: this.scPolicyId,
                quantity: 1,
              },
            ],
            datum: {
              type: 'inline',
              value: {
                contract_type: vaultConfig.contractType, // Represent an enum setup by L4VA (0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE)
                asset_whitelist:[], // POLICIES_ALLOWED_IN_THE_VAULT,
                // contributor_whitelist: [],
                asset_window: {
                  // Time allowed to upload NFT
                  lower_bound: {
                    bound_type: new Date().getTime() ,
                    is_inclusive: true,
                  },
                  upper_bound: {
                    bound_type: new Date().getTime() + one_day * 7,
                    is_inclusive: true,
                  },
                },
                investment_window: {
                  // Time allowed to upload ADA
                  lower_bound: {
                    bound_type: new Date().getTime()  ,
                    is_inclusive: true,
                  },
                  upper_bound: {
                    bound_type: new Date().getTime() + one_day * 7,
                    is_inclusive: true,
                  },
                },
                valuation_type: vaultConfig.valuationType, // Enum 0: 'FIXED' 1: 'LBE'
                // fractionalization: {
                //   percentage: 1,
                //   token_supply: 1,
                //   token_decimals: 1,
                //   token_policy: "",
                // },
                custom_metadata: [
                  // <Data,Data>
                  // [
                  //   PlutusData.new_bytes(Buffer.from("foo")).to_hex(),
                  //   PlutusData.new_bytes(Buffer.from("bar")).to_hex(),
                  // ],
                  [toHex('foo'), toHex('bar')],
                  [toHex('bar'), toHex('foo')],
                  [toHex('inc'), toHex('1')],
                ], // like a tuple

                // termination: {
                //   termination_type: 1,
                //   fdp: 1,
                // },
                // investment: {
                //   reserve: 1,
                //   liquidityPool: 1,
                // },
                admin: this.adminHash,
                minting_key: this.adminHash
              },
              shape: {
                validatorHash: this.scPolicyId,
                purpose: 'spend',
              },
            },
          },
        ],
        requiredInputs: REQUIRED_INPUTS,
      };
      const headers = {
        'x-api-key': this.anvilApiKey,
        'Content-Type': 'application/json',
      };

      // Build the transaction
      const contractDeployed = await fetch(`${this.anvilApi}/transactions/build`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });

      const buildResponse = await contractDeployed.json();

      if (!buildResponse.complete) {
        throw new Error('Failed to build complete transaction');
      }

      const txToSubmitOnChain = FixedTransaction.from_bytes(
        Buffer.from(buildResponse.complete, 'hex'),
      );
      txToSubmitOnChain.sign_and_add_vkey_signature(
        PrivateKey.from_bech32(this.adminSKey),
      );

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
        contractAddress: this.scAddress,
      };

    } catch (error) {
      this.logger.error('Failed to create vault:', error);
      throw error;
    }
  }

  async submitOnChainVaultTx(signedTx: {
    transaction: string,
    signatures: string
  }) {
    try{
      const headers = {
      'x-api-key': this.anvilApiKey,
      'Content-Type': 'application/json',
    };

      const urlSubmit = `${this.anvilApi}/transactions/submit`;
      console.log('URL ', urlSubmit);
      console.log('Headers ', headers);
      console.log('tx, signatures', signedTx);

      const submitted = await fetch(urlSubmit, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          signatures: signedTx.signatures,
          transaction: signedTx.transaction,
        }),
      });

      const output = await submitted.json();
      return output;

      // Output of published {
      //   txHash: "f24ae82f6b5b7324e96e1d0ec03085bf852c935bcec18a51c2791dc501d17724"
      // }

    }catch(error){
      this.logger.log('TX Error sending', error);
      throw new Error('Failed to build complete transaction'+  JSON.stringify(error));
    }
  }
}
