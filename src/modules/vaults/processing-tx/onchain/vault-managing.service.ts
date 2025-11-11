import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  EnterpriseAddress,
  ScriptHash,
  Credential,
  Address,
  FixedTransaction,
  PrivateKey,
  TransactionUnspentOutputs,
  TransactionUnspentOutput,
} from '@emurgo/cardano-serialization-lib-nodejs';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BlockchainService } from './blockchain.service';
import { Datum1 } from './types/type';
import { generate_tag_from_txhash_index, getUtxosExtract, getVaultUtxo } from './utils/lib';
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
  private readonly vaultScriptAddress: string;
  private readonly unparametizedScriptHash: string;
  private readonly blueprintTitle: string;
  private readonly blockfrost: BlockFrostAPI;

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
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.vaultScriptAddress = this.configService.get<string>('VAULT_SCRIPT_ADDRESS');
    this.unparametizedScriptHash = this.configService.get<string>('CONTRIBUTION_SCRIPT_HASH');
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
    scriptHash: string;
    applyParamsResult: any;
  }> {
    this.scAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(this.scPolicyId)))
      .to_address()
      .to_bech32();

    // Use the optimized function with better error handling
    const { utxos: utxoHexArray } = await getUtxosExtract(
      Address.from_bech32(vaultConfig.customerAddress),
      this.blockfrost,
      { minAda: 4000000 } // 4 ADA minimum
    );

    if (utxoHexArray.length === 0) {
      throw new Error('No UTXOs found with at least 4 ADA.');
    }

    // Convert hex array back to TransactionUnspentOutputs for compatibility
    const utxos = TransactionUnspentOutputs.new();
    utxoHexArray.forEach(utxoHex => {
      const utxo = TransactionUnspentOutput.from_hex(utxoHex);
      utxos.add(utxo);
    });

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];
    const assetName = generate_tag_from_txhash_index(
      selectedUtxo.input().transaction_id().to_hex(),
      selectedUtxo.input().index()
    );

    // Apply parameters to the blueprint before building the transaction
    const applyParamsResult = await this.blockchainService.applyBlueprintParameters({
      params: {
        [this.unparametizedScriptHash]: [
          this.scPolicyId, // policy id of the vault
          assetName, // newly created vault id from generate_tag_from_txhash_index
        ],
      },
      blueprint: {
        title: this.blueprintTitle,
        version: '0.1.1',
      },
    });

    // Upload the parameterized script
    await this.blockchainService.uploadBlueprint({
      blueprint: {
        ...applyParamsResult.preloadedScript.blueprint,
        preamble: {
          ...applyParamsResult.preloadedScript.blueprint.preamble,
          id: undefined,
          title: 'l4va/vault/' + assetName,
          version: '0.0.1',
        },
        validators: applyParamsResult.preloadedScript.blueprint.validators.filter(
          (v: any) => v.title.includes('contribute') && v.hash !== this.unparametizedScriptHash
        ),
      },
    });

    const scriptHash =
      applyParamsResult.preloadedScript.blueprint.validators.find(
        (v: any) => v.title === 'contribute.contribute.mint' && v.hash !== this.unparametizedScriptHash
      )?.hash || '';
    if (!scriptHash) {
      throw new Error('Failed to find script hash');
    }

    try {
      const input: {
        changeAddress: string;
        message: string;
        utxos: string[];
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
              datum: { type: 'script'; hash: string };
            }
        )[];
        requiredInputs: string[];
      } = {
        changeAddress: vaultConfig.customerAddress,
        message: `${vaultConfig.vaultName} Vault Creation`,
        utxos: utxoHexArray,
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
                // fractionalization: {},
                custom_metadata: [], // like a tuple
                // termination: {},
                // acquire: {},
                admin: this.adminHash,
                minting_key: this.adminHash,
              },
              shape: {
                validatorHash: this.scPolicyId,
                purpose: 'spend',
              },
            },
          },
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
  }> {
    this.logger.log(`Creating burn transaction for vault ${burnConfig.assetVaultName}`);

    try {
      if (!burnConfig.customerAddress) {
        throw new BadRequestException('Customer address is required');
      }

      if (!burnConfig.assetVaultName) {
        throw new BadRequestException('Asset vault name is required');
      }

      // Get the vault UTXO
      const vaultUtxo = await getVaultUtxo(this.scPolicyId, burnConfig.assetVaultName, this.blockfrost);

      if (!vaultUtxo) {
        throw new NotFoundException(`Vault UTXO not found for asset name ${burnConfig.assetVaultName}`);
      }

      // Create transaction input
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

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      this.logger.log(`Successfully created burn transaction for vault ${burnConfig.assetVaultName}`);

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      // this.logger.error(`Failed to create burn transaction for vault ${burnConfig.assetVaultName}:`, error);

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      if (error.status_code && error.message) {
        throw new InternalServerErrorException(`Blockchain API error (${error.status_code}): ${error.message}`);
      }

      throw new InternalServerErrorException(`Failed to create burn transaction: ${error.message || 'Unknown error'}`);
    }
  }

  async updateVaultMetadataTx({
    vault,
    transactionId,
    acquireMultiplier,
    adaPairMultiplier,
    vaultStatus,
    adaDistribution,
  }: {
    vault: Vault;
    transactionId: string;
    vaultStatus: SmartContractVaultStatus;
    acquireMultiplier?: [string, string | null, number][];
    adaPairMultiplier?: number;
    adaDistribution?: [string, string, number][];
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
      select: ['policy_id'],
    });

    if (!transaction || transaction.type !== TransactionType.updateVault) {
      throw new NotFoundException('Transaction not found');
    }

    const { utxos: adminUtxos } = await getUtxosExtract(
      Address.from_bech32(this.adminAddress),
      this.blockfrost,
      { minAda: 4000000 } // 4 ADA minimum
    );

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
      message: `Vault ${vault.id} Update`,
      utxos: adminUtxos,
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
              vault_status: vaultStatus, // Added vault_status field
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
              custom_metadata: [],
              admin: this.adminHash,
              minting_key: this.adminHash,
              acquire_multiplier: acquireMultiplier,
              ada_distribution: adaDistribution,
              ada_pair_multipler: adaPairMultiplier,
            } satisfies Datum1,
            shape: {
              validatorHash: this.scPolicyId,
              purpose: 'spend',
            },
          },
        },
      ],
      requiredSigners: [this.adminHash],
    };

    this.logger.debug('Vault update transaction input:', JSON.stringify(input));

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
        // Step 4: Update blueprint with the script transaction reference
        await this.blockchainService.uploadBlueprint({
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
        });
      } else {
        throw new Error(`Failed to create vault and upload script: 'Unknown error'`);
      }

      return { txHash: result.txHash };
    } catch (error) {
      this.logger.error('Failed to submit vault transaction', error);
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }
}
