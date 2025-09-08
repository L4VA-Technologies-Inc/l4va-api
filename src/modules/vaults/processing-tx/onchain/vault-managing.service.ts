import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  Address,
  FixedTransaction,
  PrivateKey,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BlockchainService } from './blockchain.service';
import { Datum1 } from './types/type';
import { generate_tag_from_txhash_index, getUtxos, getVaultUtxo, toHex } from './utils/lib';
import { VaultInsertingService } from './vault-inserting.service';

import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { TransactionType } from '@/types/transaction.types';
import { SmartContractVaultStatus, VaultPrivacy } from '@/types/vault.types';

export interface VaultConfig {
  vaultName: string;
  customerAddress: string;
  adminKeyHash: string;
  policyId: string;
  allowedPolicies: string[];
  allowedContributors?: string[];
  assetWindow?: {
    start: number;
    end: number;
  };
  acquireWindow?: {
    start: number;
    end: number;
  };
  acquireMultiplier?: Array<[string, string | null, number]>; // [policyId, assetName?, multiplier]
  adaPairMultiplier?: number; // 0: FIXED | 1: LBE
  contractType?: number; // 0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE
  valueMethod?: number; // 0: FIXED | 1: LBE
  customMetadata?: [string, string][];
}

export interface VaultCreateConfig {
  vaultName: string;
  customerAddress: string;
  vaultId: string;
  allowedPolicies: string[];
  allowedContributors: string[];
  assetWindow?: {
    start: number;
    end: number;
  };
  acquireWindow?: {
    start: number;
    end: number;
  };
  contractType?: number; // 0: PRIVATE | 1: PUBLIC | 2: SEMI_PRIVATE
  valueMethod?: number; // 0: FIXED | 1: LBE
  customMetadata?: [string, string][];
}

const one_day = 24 * 60 * 60 * 1000;

@Injectable()
export class VaultManagingService {
  private readonly logger = new Logger(VaultManagingService.name);
  private scAddress: string;
  private readonly scPolicyId: string;
  private readonly adminHash: string;
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly blockfrost: BlockFrostAPI;
  private readonly anvilApi: string;
  private readonly anvilApiKey: string;
  private readonly vaultScriptAddress: string;
  private readonly vaultScriptSKey: string;
  private readonly VLRM_HEX_ASSET_NAME = '4d494e';
  private readonly VLRM_POLICY_ID = 'e16c2dc8ae937e8d3790c7fd7168d7b994621ba14ca11415f39fed72';
  private readonly VLRM_CREATOR_FEE = 1000;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService,
    private readonly vaultInsertingService: VaultInsertingService
  ) {
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.vaultScriptAddress = this.configService.get<string>('VAULT_SCRIPT_ADDRESS');
    this.vaultScriptSKey = this.configService.get<string>('VAULT_SCRIPT_SKEY');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
    this.anvilApi = this.configService.get<string>('ANVIL_API_URL') + '/services';
    this.anvilApiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  /**
   * Create a new vault with the specified configuration
   * @param config Vault configuration parameters
   * @returns Transaction hash and vault ID
   */
  async createOnChainVaultTx(vaultConfig: VaultCreateConfig): Promise<{
    presignedTx: string;
    contractAddress: string;
    vaultAssetName: string;
    scriptHash: string;
    applyParamsResult: any;
  }> {
    this.scAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(this.scPolicyId)))
      .to_address()
      .to_bech32();

    const utxos = await getUtxos(Address.from_bech32(vaultConfig.customerAddress), 0, this.blockfrost); // Any UTXO works.
    if (utxos.len() === 0) {
      throw new Error('No UTXOs found.');
    }

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];
    const assetName = generate_tag_from_txhash_index(
      selectedUtxo.input().transaction_id().to_hex(),
      selectedUtxo.input().index()
    );

    const headers = {
      'x-api-key': this.anvilApiKey,
      'Content-Type': 'application/json',
    };

    // Apply parameters to the blueprint before building the transaction
    const applyParamsPayload = {
      params: {
        //9a9b0bc93c26a40952aaff525ac72a992a77ebfa29012c9cb4a72eb2 contribution script hash
        '9a9b0bc93c26a40952aaff525ac72a992a77ebfa29012c9cb4a72eb2': [
          this.scPolicyId, // policy id of the vault
          assetName, // newly created vault id from generate_tag_from_txhash_index
        ],
      },
      blueprint: {
        title: 'l4va/vault',
        version: '0.0.7',
      },
    };

    const applyParamsResponse = await fetch(`${this.anvilApi}/blueprints/apply-params`, {
      method: 'POST',
      headers,
      body: JSON.stringify(applyParamsPayload),
    });

    const applyParamsResult = await applyParamsResponse.json();

    if (!applyParamsResult.preloadedScript) {
      throw new Error('Failed to apply parameters to blueprint');
    }

    // Step 2: Upload the parameterized script to /blueprints
    const uploadScriptResponse = await fetch(`${this.anvilApi}/blueprints`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        blueprint: {
          ...applyParamsResult.preloadedScript.blueprint,
          preamble: {
            ...applyParamsResult.preloadedScript.blueprint.preamble,
            id: undefined,
            title: 'l4va/vault/' + assetName,
            version: '0.0.1',
          },
          validators: applyParamsResult.preloadedScript.blueprint.validators.filter((v: any) =>
            v.title.includes('contribute')
          ),
        },
      }),
    });

    await uploadScriptResponse.json();

    const scriptHash =
      applyParamsResult.preloadedScript.blueprint.validators.find((v: any) => v.title === 'contribute.contribute.mint')
        ?.hash || '';
    if (!scriptHash) {
      throw new Error('Failed to find script hash');
    }

    // const vaultAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)))
    //   .to_address()
    //   .to_bech32();

    try {
      const input: {
        changeAddress: string;
        message: string;
        mint: Array<object>;
        scriptInteractions: object[];
        outputs: (
          | {
              address: string;
              assets: object[];
              datum: { type: 'inline'; value: Datum1; shape: object };
            }
          | {
              address: string;
              assets: object[];
            }
          | {
              address: string;
              datum: { type: 'script'; hash: string };
            }
        )[];
        requiredInputs: string[];
      } = {
        changeAddress: vaultConfig.customerAddress,
        message: vaultConfig.vaultName,
        mint: [
          {
            version: 'cip25',
            assetName: { name: assetName, format: 'hex' },
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
                assetName: { name: assetName, format: 'hex' },
                policyId: this.scPolicyId,
                quantity: 1,
              },
            ],
            datum: {
              type: 'inline',
              value: {
                vault_status: SmartContractVaultStatus.OPEN,
                contract_type: vaultConfig.contractType,
                asset_whitelist: vaultConfig.allowedPolicies,
                // contributor_whitelist: vaultConfig.allowedContributors, // address list of contributors
                asset_window: {
                  // Time allowed to upload NFT
                  lower_bound: {
                    bound_type: new Date().getTime(),
                    is_inclusive: true,
                  },
                  upper_bound: {
                    bound_type: new Date(vaultConfig.assetWindow.end).getTime() + one_day,
                    is_inclusive: true,
                  },
                },
                acquire_window: {
                  // Time allowed to upload ADA
                  lower_bound: {
                    bound_type: new Date(vaultConfig.acquireWindow.start).getTime(),
                    is_inclusive: true,
                  },
                  upper_bound: {
                    bound_type: new Date(vaultConfig.acquireWindow.end).getTime() + one_day,
                    is_inclusive: true,
                  },
                },
                valuation_type: vaultConfig.valueMethod, // Enum 0: 'FIXED' 1: 'LBE'
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
                  [toHex('vaultId'), toHex(vaultConfig.vaultId)],
                ], // like a tuple

                // termination: {
                //   termination_type: 1,
                //   fdp: 1,
                // },
                // acquire: {
                //   reserve: 1,
                //   liquidityPool: 1,
                // },
                admin: this.adminHash,
                minting_key: this.adminHash,
              },
              shape: {
                validatorHash: this.scPolicyId,
                purpose: 'spend',
              },
            },
          },
          // {
          //   address: vaultAddress,
          //   assets: [
          //     {
          //       assetName: { name: this.VLRM_HEX_ASSET_NAME, format: 'hex' },
          //       policyId: this.VLRM_POLICY_ID,
          //       quantity: this.VLRM_CREATOR_FEE,
          //     },
          //   ],
          // },
          {
            address: this.vaultScriptAddress,
            datum: {
              type: 'script',
              hash: scriptHash,
            },
          },
        ],
        requiredInputs: REQUIRED_INPUTS,
      };
      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Sign the transaction
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
        contractAddress: this.scAddress,
        vaultAssetName: assetName,
        scriptHash,
        applyParamsResult,
      };
    } catch (error) {
      this.logger.error('Failed to create vault:', error);
      throw error;
    }
  }

  async createBurnTx(burnConfig: { customerAddress: string; assetVaultName: string }): Promise<{
    presignedTx: string;
    contractAddress: string;
  }> {
    const vaultUtxo = await getVaultUtxo(this.scPolicyId, burnConfig.assetVaultName, this.blockfrost);
    const input = {
      changeAddress: burnConfig.customerAddress,
      message: 'Vault Burn',
      scriptInteractions: [
        {
          purpose: 'spend',
          outputRef: vaultUtxo,
          hash: this.scPolicyId,
          redeemer: {
            type: 'json',
            value: 'VaultBurn',
          },
        },
        {
          purpose: 'mint',
          hash: this.scPolicyId,
          redeemer: {
            type: 'json',
            value: 'VaultBurn',
          },
        },
      ],
      mint: [
        {
          version: 'cip25',
          assetName: { name: burnConfig.assetVaultName, format: 'hex' },
          policyId: this.scPolicyId,
          type: 'plutus',
          quantity: -1,
        },
      ],
      requiredSigners: [this.adminHash],
    };
    const buildResponse = await this.blockchainService.buildTransaction(input);

    // Sign the transaction
    const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
    txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

    return {
      presignedTx: txToSubmitOnChain.to_hex(),
      contractAddress: this.scAddress,
    };
  }

  // Create a transaction to update the vault's metadata
  async updateVaultMetadataTx({
    vault,
    transactionId,
    acquireMultiplier,
    adaPairMultiplier,
  }: {
    vault: Vault;
    transactionId: string;
    acquireMultiplier: [string, string | null, number][];
    adaPairMultiplier: number;
  }): Promise<{
    success: boolean;
    txHash: string;
    message: string;
  }> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId },
    });

    const assetsWhitelist = await this.assetsWhitelistRepository.find({
      where: { vault: { id: vault.id } },
    });

    if (!transaction || transaction.type !== TransactionType.updateVault) {
      throw new NotFoundException('Transaction not found');
    }

    const allowedPolicies: string[] =
      Array.isArray(assetsWhitelist) && assetsWhitelist.length > 0
        ? assetsWhitelist.map(policy => policy.policy_id)
        : [];
    const contract_type = vault.privacy === VaultPrivacy.private ? 0 : vault.privacy === VaultPrivacy.public ? 1 : 2;

    this.scAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(this.scPolicyId)))
      .to_address()
      .to_bech32();

    const vaultUtxo = await getVaultUtxo(this.scPolicyId, vault.asset_vault_name, this.blockfrost);
    const input = {
      changeAddress: this.adminAddress,
      message: 'Vault Update',
      scriptInteractions: [
        {
          purpose: 'spend',
          outputRef: vaultUtxo,
          hash: this.scPolicyId,
          redeemer: {
            type: 'json',
            value: {
              vault_token_index: 0, // must fit the ordering defined in the outputs array
              asset_name: vault.asset_vault_name,
            },
          },
        },
      ],
      outputs: [
        {
          address: this.scAddress,
          assets: [
            {
              assetName: vault.asset_vault_name,
              policyId: this.scPolicyId,
              quantity: 1,
            },
          ],
          datum: {
            type: 'inline',
            value: {
              vault_status: SmartContractVaultStatus.SUCCESSFUL, // Added vault_status field
              contract_type: contract_type,
              asset_whitelist: allowedPolicies,
              // contributor_whitelist: vaultConfig.allowedContributors || [],
              asset_window: {
                lower_bound: {
                  bound_type: new Date(vault.contribution_phase_start).getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date(vault.acquire_phase_start).getTime(),
                  is_inclusive: true,
                },
              },
              acquire_window: {
                lower_bound: {
                  bound_type: new Date(vault.acquire_phase_start).getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date().getTime(), // current time
                  is_inclusive: true,
                },
              },
              valuation_type: vault.value_method === 'fixed' ? 0 : 1,
              custom_metadata: [
                // <Data,Data>
                // [
                //   PlutusData.new_bytes(Buffer.from("foo")).to_hex(),
                //   PlutusData.new_bytes(Buffer.from("bar")).to_hex(),
                // ],
                [toHex('foo'), toHex('bar')],
                [toHex('bar'), toHex('foo')],
                [toHex('inc'), toHex('3')],
              ],
              admin: this.adminHash,
              minting_key: this.adminHash,
              // New fields from update_vault.ts
              acquire_multiplier: acquireMultiplier,
              ada_pair_multiplier: adaPairMultiplier,
            },
            shape: {
              validatorHash: this.scPolicyId,
              purpose: 'spend',
            },
          },
        },
      ],
      requiredSigners: [this.adminHash],
    };

    try {
      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const response = await this.vaultInsertingService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
        vaultId: vault.id,
        txId: transaction.id,
      });

      return { success: true, txHash: response.txHash, message: 'Transaction submitted successfully' };
    } catch (error) {
      this.logger.error('Failed to build vault update tx:', error);
      throw error;
    }
  }

  /**
   * Refunds collateral from vault script address back to vault owner
   * @param vaultOwnerAddress Address of the vault owner who will receive the refund
   * @param collateralUtxo UTXO containing the collateral (format: txHash#index)
   * @returns Transaction hash of the refund transaction
   */
  async createRefundCollateralTx({
    vaultOwnerAddress,
    collateralUtxo,
  }: {
    vaultOwnerAddress: string;
    collateralUtxo: string;
  }): Promise<{
    txHash: string;
  }> {
    try {
      this.logger.log(`Creating refund transaction for collateral UTXO ${collateralUtxo} to ${vaultOwnerAddress}`);

      const [txHash, indexStr] = collateralUtxo.split('#');
      const index = parseInt(indexStr);

      if (!txHash || isNaN(index)) {
        throw new Error('Invalid UTXO format. Expected format: txHash#index');
      }

      const utxoDetails = await this.blockfrost.txsUtxos(txHash);

      if (!utxoDetails || !utxoDetails.outputs || utxoDetails.outputs.length <= index) {
        throw new Error(`UTXO ${collateralUtxo} not found`);
      }

      // Find the output with the script address that contains the collateral
      const scriptOutput = utxoDetails.outputs.find(output => output.address === this.vaultScriptAddress);

      if (!scriptOutput) {
        throw new Error(`No output found with vault script address ${this.vaultScriptAddress}`);
      }

      const amount = Number(scriptOutput.amount[0].quantity);

      if (amount <= 0) {
        throw new Error(`Collateral UTXO has zero or negative ADA amount: ${amount}`);
      }

      const input = {
        changeAddress: this.vaultScriptAddress,
        message: 'Refund Collateral',
        // utxos: REQUIRED_INPUTS,
        outputs: [
          {
            address: vaultOwnerAddress,
            lovelace: amount - 1000000,
          },
        ],
      };

      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.vaultScriptSKey));

      const result = await this.blockchainService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
        signatures: [],
      });

      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Failed to create refund collateral transaction:', error);
      throw error;
    }
  }

  /**
   * Submit a signed vault transaction to the blockchain
   * @param signedTx Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitOnChainVaultTx(
    signedTx: { transaction: string; signatures: string | string[] },
    assetName: string,
    scriptHash: string,
    applyParamsResult: any
  ): Promise<{
    txHash: string;
  }> {
    try {
      // Ensure signatures is always an array
      const signatures = Array.isArray(signedTx.signatures) ? signedTx.signatures : [signedTx.signatures];

      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures,
      });
      const { txHash } = result;

      if (txHash) {
        const headers = {
          'x-api-key': this.anvilApiKey,
          'Content-Type': 'application/json',
        };

        // Step 4: Update blueprint with the script transaction reference
        const blueprintUpdatePayload = {
          blueprint: {
            ...applyParamsResult.preloadedScript.blueprint,
            preamble: {
              ...applyParamsResult.preloadedScript.blueprint.preamble,
              id: undefined,
              title: 'l4va/vault/' + assetName,
              version: '0.0.1',
            },
            validators: applyParamsResult.preloadedScript.blueprint.validators.filter((v: any) =>
              v.title.includes('contribute')
            ),
          },
          refs: {
            [scriptHash]: {
              txHash: txHash,
              index: 1, // Script output is at index 1 (vault is at index 0)
            },
          },
        };

        await fetch(`${this.anvilApi}/blueprints`, {
          method: 'POST',
          headers,
          body: JSON.stringify(blueprintUpdatePayload),
        });

        this.logger.log('✅ Complete workflow finished: vault created, script uploaded, and blueprint updated!');
      } else {
        console.error('Failed to create vault and upload script');
      }

      return { txHash };
    } catch (error) {
      this.logger.error('Failed to submit vault transaction', error);
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }
}
