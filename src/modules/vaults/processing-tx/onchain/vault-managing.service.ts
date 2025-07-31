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
import { generate_assetname_from_txhash_index, getUtxos, getVaultUtxo, toHex } from './utils/lib';
import { VaultInsertingService } from './vault-inserting.service';

import { Transaction } from '@/database/transaction.entity';
import { TransactionType } from '@/types/transaction.types';

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
  private readonly blockfrost: any;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService,
    private readonly vaultInsertingService: VaultInsertingService
  ) {
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
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
    const assetName = generate_assetname_from_txhash_index(
      selectedUtxo.input().transaction_id().to_hex(),
      selectedUtxo.input().index()
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
                vault_status: 1,
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
                    bound_type: new Date().getTime() + one_day,
                    is_inclusive: true,
                  },
                },
                acquire_window: {
                  // Time allowed to upload ADA
                  lower_bound: {
                    bound_type: new Date().getTime(),
                    is_inclusive: true,
                  },
                  upper_bound: {
                    bound_type: new Date().getTime() + one_day,
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
  async updateVaultMetadataTx(transactionId: string): Promise<{
    success: boolean;
    txHash: string;
    message: string;
  }> {
    const transaction = await this.transactionRepository.findOne({
      where: { id: transactionId },
      relations: ['vault'],
    });

    if (!transaction || transaction.type !== TransactionType.updateVault) {
      throw new NotFoundException('Transaction not found');
    }

    const vaultConfig: VaultConfig = {
      ...(transaction.metadata as VaultConfig),
      acquireMultiplier: transaction.metadata.acquireMultiplier.map((item: [string, string | null, number]) => [
        item[0],
        item[1] || '',
        item[2],
      ]),
      adaPairMultiplier: Number(transaction.metadata.adaPairMultiplier),
    };

    this.scAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(this.scPolicyId)))
      .to_address()
      .to_bech32();

    const vaultUtxo = await getVaultUtxo(this.scPolicyId, vaultConfig.vaultName, this.blockfrost);
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
              asset_name: vaultConfig.vaultName,
            },
          },
        },
      ],
      outputs: [
        {
          address: this.scAddress,
          assets: [
            {
              assetName: vaultConfig.vaultName,
              policyId: this.scPolicyId,
              quantity: 1,
            },
          ],
          datum: {
            type: 'inline',
            value: {
              vault_status: 2, // Added vault_status field
              contract_type: vaultConfig.contractType || 0,
              asset_whitelist: vaultConfig.allowedPolicies || [],
              // contributor_whitelist: vaultConfig.allowedContributors || [],
              asset_window: vaultConfig.assetWindow || {
                lower_bound: {
                  bound_type: new Date().getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date().getTime() + 24 * 60 * 60 * 1000, // Default 1 day
                  is_inclusive: true,
                },
              },
              acquire_window: vaultConfig.acquireWindow || {
                lower_bound: {
                  bound_type: new Date().getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date().getTime() + 24 * 60 * 60 * 1000, // Default 1 day
                  is_inclusive: true,
                },
              },
              valuation_type: vaultConfig.valueMethod || 0,
              custom_metadata: vaultConfig.customMetadata || [],
              admin: this.adminHash,
              minting_key: this.adminHash,
              // New fields from update_vault.ts
              acquire_multiplier: vaultConfig.acquireMultiplier,
              ada_pair_multiplier: vaultConfig.adaPairMultiplier || 1,
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
        vaultId: transaction.vault.id,
        txId: transaction.id,
      });

      return { success: true, txHash: response.txHash, message: 'Transaction submitted successfully' };
    } catch (error) {
      this.logger.error('Failed to build vault update tx:', error);
      throw error;
    }
  }

  /**
   * Submit a signed vault transaction to the blockchain
   * @param signedTx Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitOnChainVaultTx(signedTx: { transaction: string; signatures: string | string[] }): Promise<{
    txHash: string;
  }> {
    try {
      // Ensure signatures is always an array
      const signatures = Array.isArray(signedTx.signatures) ? signedTx.signatures : [signedTx.signatures];

      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures,
      });

      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Failed to submit vault transaction', error);
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }
}
