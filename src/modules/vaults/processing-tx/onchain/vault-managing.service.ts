import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
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

import { PublishVaultDto } from '../../dto/publish-vault.dto';

import { BlockchainService } from './blockchain.service';
import { Datum1 } from './types/type';
import {
  createUtxoHex,
  generate_tag_from_txhash_index,
  getAddressFromHash,
  getUtxosExtract,
  getVaultUtxo,
} from './utils/lib';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { SystemSettings } from '@/database/systemSettings.entity';
import { Vault } from '@/database/vault.entity';
import { VaultCreationInput } from '@/modules/distribution/distribution.types';
import { TransactionsService } from '@/modules/vaults/processing-tx/offchain-tx/transactions.service';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
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
  private readonly vaultScriptSKey: string;
  private readonly unparametizedScriptHash: string;
  private readonly blueprintTitle: string;
  private readonly blockfrost: BlockFrostAPI;

  private readonly VLRM_HEX_ASSET_NAME: string;
  private readonly VLRM_POLICY_ID: string;
  private VLRM_CREATOR_FEE: number;
  private readonly VLRM_CREATOR_FEE_ENABLED: boolean;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    @InjectRepository(SystemSettings)
    private readonly systemSettingsRepository: Repository<SystemSettings>,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService,
    private readonly transactionsService: TransactionsService
  ) {
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.vaultScriptAddress = this.configService.get<string>('VAULT_SCRIPT_ADDRESS');
    this.vaultScriptSKey = this.configService.get<string>('VAULT_SCRIPT_SKEY');
    this.unparametizedScriptHash = this.configService.get<string>('CONTRIBUTION_SCRIPT_HASH');
    this.VLRM_HEX_ASSET_NAME = this.configService.get<string>('VLRM_HEX_ASSET_NAME');
    this.VLRM_POLICY_ID = this.configService.get<string>('VLRM_POLICY_ID');
    this.VLRM_CREATOR_FEE_ENABLED = this.configService.get<string>('VLRM_CREATOR_FEE_ENABLED') === 'true';
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
    });
  }

  async onModuleInit(): Promise<void> {
    const settings = await this.systemSettingsRepository.find();
    this.VLRM_CREATOR_FEE = settings?.[0]?.data?.vlrm_creator_fee || 100;
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
    transactionId: string;
    applyParamsResult: any;
  }> {
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultConfig.vaultId,
      type: TransactionType.createVault,
      assets: [], // No assets needed for this transaction as it's metadata update
    });

    this.scAddress = getAddressFromHash(this.scPolicyId);

    // Use the optimized function with better error handling
    const { filteredUtxos: utxoHexArray, requiredInputs } = await getUtxosExtract(
      Address.from_bech32(vaultConfig.customerAddress),
      this.blockfrost,
      {
        minAda: 2000000,
        filterByAda: 8000000,
        validateUtxos: false,
        ...(this.VLRM_CREATOR_FEE_ENABLED && {
          targetAssets: [{ token: `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`, amount: this.VLRM_CREATOR_FEE }],
        }),
      } // 4 ADA minimum
    );

    // Convert hex array back to TransactionUnspentOutputs for compatibility
    const utxos = TransactionUnspentOutputs.new();
    utxoHexArray.forEach(utxoHex => {
      const utxo = TransactionUnspentOutput.from_hex(utxoHex);
      utxos.add(utxo);
    });

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex(), ...requiredInputs];
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

    const vaultAddress = getAddressFromHash(scriptHash);

    try {
      const input: VaultCreationInput = {
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
                asset_whitelist: [...vaultConfig.allowedPolicies, this.VLRM_POLICY_ID],
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
          ...(this.VLRM_CREATOR_FEE_ENABLED
            ? [
                {
                  address: vaultAddress,
                  assets: [
                    {
                      assetName: { name: this.VLRM_HEX_ASSET_NAME, format: 'hex' },
                      policyId: this.VLRM_POLICY_ID,
                      quantity: this.VLRM_CREATOR_FEE,
                    },
                  ],
                },
              ]
            : []),
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
        transactionId: transaction.id,
      };
    } catch (error) {
      this.logger.error('Failed to create vault:', error);
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);

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
    acquireMultiplier,
    adaPairMultiplier,
    vaultStatus,
    adaDistribution,
  }: {
    vault: Vault;
    vaultStatus: SmartContractVaultStatus;
    acquireMultiplier?: [string, string | null, number][];
    adaPairMultiplier?: number;
    adaDistribution?: [string, string, number][];
  }): Promise<{
    success: boolean;
    txHash: string;
    message: string;
  }> {
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vault.id,
      type: TransactionType.updateVault,
      assets: [], // No assets needed for this transaction as it's metadata update
    });

    const assetsWhitelist = await this.assetsWhitelistRepository.find({
      where: { vault: { id: vault.id } },
      select: ['policy_id'],
    });

    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 4000000,
      maxUtxos: 5,
    });

    const requiredInputs = [];

    const allowedPolicies: string[] =
      Array.isArray(assetsWhitelist) && assetsWhitelist.length > 0
        ? assetsWhitelist.map(policy => policy.policy_id)
        : [];
    const contract_type = vault.privacy === VaultPrivacy.private ? 0 : vault.privacy === VaultPrivacy.public ? 1 : 2;

    this.scAddress = getAddressFromHash(this.scPolicyId);

    const vaultUtxo = await getVaultUtxo(this.scPolicyId, vault.asset_vault_name, this.blockfrost);

    const utxoDetails = await this.blockfrost.txsUtxos(vault.publication_hash);

    let refScriptPayBackAmount = 0;

    if (utxoDetails && utxoDetails.outputs) {
      // Find the output with the script address that contains the collateral
      const scriptOutputIndex = utxoDetails.outputs.findIndex(output => output.address === this.vaultScriptAddress);

      if (scriptOutputIndex !== -1) {
        const scriptOutput = utxoDetails.outputs[scriptOutputIndex];
        refScriptPayBackAmount = Number(scriptOutput.amount[0].quantity);

        if (refScriptPayBackAmount > 0) {
          // Create the UTXO reference for the script collateral
          const scriptUtxoHex = createUtxoHex(
            vault.publication_hash,
            scriptOutputIndex,
            Address.from_bech32(this.vaultScriptAddress),
            [{ unit: 'lovelace', quantity: refScriptPayBackAmount }]
          );

          adminUtxos.push(scriptUtxoHex);
          requiredInputs.push(scriptUtxoHex);
        } else {
          this.logger.warn(`Script UTXO has zero or negative ADA amount: ${refScriptPayBackAmount}, skipping refund`);
        }
      } else {
        this.logger.warn(`No output found with vault script address ${this.vaultScriptAddress}, skipping refund`);
      }
    } else {
      this.logger.warn(`Transaction ${vault.publication_hash} outputs not found, skipping script UTXO refund`);
    }

    const input = {
      changeAddress: this.adminAddress,
      message: `Vault ${vault.id} ${vaultStatus === SmartContractVaultStatus.SUCCESSFUL ? 'Locked' : vaultStatus === SmartContractVaultStatus.CANCELLED ? 'Failed' : 'Unknown'} Update`,
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
                  bound_type: new Date(
                    vault.contribution_phase_start.getTime() + Number(vault.contribution_duration)
                  ).getTime(),
                  is_inclusive: true,
                },
              },
              acquire_window: {
                lower_bound: {
                  bound_type: vault.acquire_phase_start ? vault.acquire_phase_start.getTime() : new Date().getTime(),
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
      requiredInputs,
      requiredSigners: [this.adminHash],
    };

    if (refScriptPayBackAmount > 0) {
      input.outputs.push({
        address: vault.owner.address, // Send back to vault owner
        lovelace: refScriptPayBackAmount, // Refund amount (adjust based on actual collateral)
      } as any);
    }

    this.logger.debug('Vault update transaction input:', JSON.stringify(input));
    try {
      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.vaultScriptSKey));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const response = await this.blockchainService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
      });

      await this.transactionsService.updateTransactionHash(transaction.id, response.txHash);
      return { success: true, txHash: response.txHash, message: 'Transaction submitted successfully' };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);
      this.logger.error('Failed to build vault update tx:', error);
      throw error;
    }
  }

  /**
   * Submit a signed vault transaction to the blockchain
   * @param signedTx Object containing the transaction and signatures
   * @returns Transaction hash
   */
  async submitOnChainVaultTx(
    signedTx: PublishVaultDto,
    vault: Vault,
    ownerId: string
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

      await this.transactionsService.updateTransactionHash(signedTx.txId, result.txHash);

      if (this.VLRM_CREATOR_FEE_ENABLED && this.VLRM_CREATOR_FEE > 0) {
        const vlrmAsset = this.assetsRepository.create({
          vault: { id: vault.id },
          policy_id: this.VLRM_POLICY_ID,
          asset_id: `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`,
          type: AssetType.FT,
          quantity: this.VLRM_CREATOR_FEE,
          status: AssetStatus.PENDING,
          origin_type: AssetOriginType.FEE,
          transaction: { id: signedTx.txId },
          added_by: { id: ownerId },
          image: 'ipfs://QmdYu513Bu7nfKV5LKP6cmpZ8HHXifQLH6FTTzv3VbbqwP', // VLRM logo
          metadata: {
            purpose: 'vault_creation_fee',
          },
        });

        await this.assetsRepository.save(vlrmAsset);

        this.logger.log(`Created VLRM asset record for vault ${vault.id}: ${this.VLRM_CREATOR_FEE} tokens`);
      }

      if (result.txHash) {
        // Step 4: Update blueprint with the script transaction reference
        await this.blockchainService.uploadBlueprint({
          blueprint: {
            ...vault.apply_params_result.preloadedScript.blueprint,
            preamble: {
              ...vault.apply_params_result.preloadedScript.blueprint.preamble,
              id: undefined,
              title: 'l4va/vault/' + vault.asset_vault_name,
              version: '0.0.1',
            },
            validators: vault.apply_params_result.preloadedScript.blueprint.validators.filter((v: any) =>
              v.title.includes('contribute')
            ),
          },
          refs: {
            [vault.script_hash]: {
              txHash: result.txHash,
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
