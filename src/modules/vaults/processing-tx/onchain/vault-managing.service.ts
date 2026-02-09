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
import { generate_tag_from_txhash_index, getAddressFromHash, getUtxosExtract, getVaultUtxo } from './utils/lib';

import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { Vault } from '@/database/vault.entity';
import { VaultCreationInput } from '@/modules/distribution/distribution.types';
import { SystemSettingsService } from '@/modules/globals/system-settings';
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
  userId: string;
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
  private readonly networkId: number;
  private readonly blockfrost: BlockFrostAPI;

  private readonly VLRM_HEX_ASSET_NAME: string;
  private readonly VLRM_POLICY_ID: string;

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    private readonly configService: ConfigService,
    @Inject(BlockchainService)
    private readonly blockchainService: BlockchainService,
    private readonly transactionsService: TransactionsService,
    private readonly systemSettingsService: SystemSettingsService
  ) {
    this.blueprintTitle = this.configService.get<string>('BLUEPRINT_TITLE');
    this.scPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.vaultScriptAddress = this.configService.get<string>('VAULT_SCRIPT_ADDRESS');
    this.unparametizedScriptHash = this.configService.get<string>('CONTRIBUTION_SCRIPT_HASH');
    this.VLRM_HEX_ASSET_NAME = this.configService.get<string>('VLRM_HEX_ASSET_NAME');
    this.VLRM_POLICY_ID = this.configService.get<string>('VLRM_POLICY_ID');
    this.networkId = Number(this.configService.get<string>('NETWORK_ID')) || 0;
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
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
    transactionId: string;
    applyParamsResult: any;
  }> {
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultConfig.vaultId,
      type: TransactionType.createVault,
      userId: vaultConfig.userId,
      assets: [], // No assets needed for this transaction as it's metadata update
    });

    this.scAddress = getAddressFromHash(this.scPolicyId, this.networkId);

    // Use the optimized function with better error handling
    let utxoHexArray: string[];
    let requiredInputs: string[];

    try {
      const result = await getUtxosExtract(
        Address.from_bech32(vaultConfig.customerAddress),
        this.blockfrost,
        {
          minAda: 2000000,
          filterByAda: 8000000,
          validateUtxos: false,
          ...(this.systemSettingsService.vlrmCreatorFeeEnabled && {
            targetAssets: [
              {
                token: `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`,
                amount: this.systemSettingsService.vlrmCreatorFee,
              },
            ],
          }),
        } // 4 ADA minimum
      );
      utxoHexArray = result.filteredUtxos;
      requiredInputs = result.requiredInputs;
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);

      // Check if this is an insufficient assets error
      if (error.message && error.message.includes('Insufficient assets found')) {
        // Check if it's specifically about VLRM tokens
        const vlrmToken = `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`;
        if (error.message.includes(vlrmToken)) {
          const requiredVlrm = this.systemSettingsService.vlrmCreatorFee;
          throw new BadRequestException(
            `Insufficient VLRM tokens. You need ${requiredVlrm} VLRM tokens to create a vault. Please acquire more VLRM tokens and try again.`
          );
        }
        // Other asset insufficiency
        throw new BadRequestException(
          `${error.message}. Please ensure your wallet has the required tokens and try again.`
        );
      }

      // Check if this is an insufficient ADA error
      if (error.message && error.message.includes('Insufficient ADA found')) {
        throw new BadRequestException(
          'Insufficient ADA balance. You need at least 8 ADA in your wallet to create a vault. Please add more ADA and try again.'
        );
      }

      // For other UTXO-related errors, likely client-side issues
      if (error.message) {
        this.logger.error(`Failed to extract UTXOs for vault creation: ${error.message}`);
        throw new BadRequestException(
          `Unable to create vault: ${error.message}. Please ensure your wallet has sufficient funds and UTXOs are available.`
        );
      }

      // Unexpected server errors
      this.logger.error('Unexpected error during vault creation:', error);
      throw new InternalServerErrorException(
        'An unexpected error occurred while creating the vault. Please try again later.'
      );
    }

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

    const vaultAddress = getAddressFromHash(scriptHash, this.networkId);

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
          ...(this.systemSettingsService.vlrmCreatorFeeEnabled
            ? [
                {
                  address: vaultAddress,
                  assets: [
                    {
                      assetName: { name: this.VLRM_HEX_ASSET_NAME, format: 'hex' },
                      policyId: this.VLRM_POLICY_ID,
                      quantity: this.systemSettingsService.vlrmCreatorFee,
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

  async createBurnTx(burnConfig: {
    vaultId: string;
    vaultOwnerAddress: string;
    assetVaultName: string;
    publicationHash: string;
  }): Promise<{
    presignedTx: string;
    txId: string;
  }> {
    this.logger.log(`Creating burn transaction for vault ${burnConfig.assetVaultName}`);
    const transaction = await this.transactionsService.createTransaction({
      vault_id: burnConfig.vaultId,
      type: TransactionType.burn,
      assets: [],
    });

    try {
      if (!burnConfig.vaultOwnerAddress) {
        throw new BadRequestException('Customer address is required');
      }

      if (!burnConfig.assetVaultName) {
        throw new BadRequestException('Asset vault name is required');
      }

      const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
        minAda: 4000000,
        validateUtxos: false,
      });

      const requiredInputs: string[] = [];

      // Get the vault UTXO
      const vaultUtxo = await getVaultUtxo(this.scPolicyId, burnConfig.assetVaultName, this.blockfrost);

      if (!vaultUtxo) {
        throw new NotFoundException(`Vault UTXO not found for asset name ${burnConfig.assetVaultName}`);
      }

      // Create transaction input
      const input = {
        changeAddress: burnConfig.vaultOwnerAddress,
        message: 'Vault Burn',
        utxos: adminUtxos,
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
        requiredInputs,
        outputs: [],
      };

      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      return {
        presignedTx: txToSubmitOnChain.to_hex(),
        txId: transaction.id,
      };
    } catch (error) {
      await this.transactionsService.updateTransactionStatusById(transaction.id, TransactionStatus.failed);

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      if (error.status_code && error.message) {
        throw new InternalServerErrorException(`Blockchain API error (${error.status_code}): ${error.message}`);
      }

      throw new InternalServerErrorException(`Failed to create burn transaction: ${error.message || 'Unknown error'}`);
    }
  }

  async updateVaultMetadataTx(config: {
    vault: Pick<
      Vault,
      'id' | 'asset_vault_name' | 'privacy' | 'contribution_phase_start' | 'contribution_duration' | 'value_method'
    >;
    vaultStatus: SmartContractVaultStatus;
    acquireMultiplier?: [string, string | null, number][];
    adaPairMultiplier?: number;
    adaDistribution?: [string, string | null, number][];
    asset_window?: {
      start: number;
      end: number;
    };
    acquire_window?: {
      start: number;
      end: number;
    };
  }): Promise<{
    success: boolean;
    txHash: string;
    message: string;
  }> {
    const {
      vault,
      vaultStatus,
      asset_window,
      acquire_window,
      acquireMultiplier = [],
      adaPairMultiplier = 0,
      adaDistribution = [],
    } = config;
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
      validateUtxos: false,
    });

    const requiredInputs: string[] = [];

    const allowedPolicies: string[] =
      Array.isArray(assetsWhitelist) && assetsWhitelist.length > 0
        ? assetsWhitelist.map(policy => policy.policy_id)
        : [];
    const contract_type = vault.privacy === VaultPrivacy.private ? 0 : vault.privacy === VaultPrivacy.public ? 1 : 2;

    this.scAddress = getAddressFromHash(this.scPolicyId, this.networkId);

    const vaultUtxo = await getVaultUtxo(this.scPolicyId, vault.asset_vault_name, this.blockfrost);

    let vaultMessageStatus = '';
    if (vaultStatus === SmartContractVaultStatus.SUCCESSFUL) {
      vaultMessageStatus = 'Locked';
    } else if (vaultStatus === SmartContractVaultStatus.CANCELLED) {
      vaultMessageStatus = 'Failed';
    } else if (vaultStatus === SmartContractVaultStatus.OPEN) {
      vaultMessageStatus = 'Open';
    } else {
      vaultMessageStatus = 'Unknown';
    }
    const input = {
      changeAddress: this.adminAddress,
      message: `Vault ${vault.id} ${vaultMessageStatus} Update`,
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
                  bound_type: new Date(asset_window?.start || vault.contribution_phase_start).getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date(
                    (asset_window?.end ? new Date(asset_window.end) : vault.contribution_phase_start).getTime() +
                      Number(vault.contribution_duration)
                  ).getTime(),
                  is_inclusive: true,
                },
              },
              acquire_window: {
                lower_bound: {
                  bound_type: acquire_window?.start ? new Date(acquire_window.start).getTime() : new Date().getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: acquire_window?.end ? new Date(acquire_window.end).getTime() : new Date().getTime(),
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

    this.logger.debug('Vault update transaction input:', JSON.stringify(input));
    try {
      // Build the transaction using BlockchainService
      const buildResponse = await this.blockchainService.buildTransaction(input);

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
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
   * TEST METHOD: Estimate the transaction size for an update vault operation
   * This builds the transaction without creating a transaction record or submitting it
   * Useful for validating that transactions with large multiplier arrays will fit within Cardano limits
   */
  async estimateUpdateVaultTxSize(config: {
    vault: Pick<
      Vault,
      'id' | 'asset_vault_name' | 'privacy' | 'contribution_phase_start' | 'contribution_duration' | 'value_method'
    >;
    vaultStatus: SmartContractVaultStatus;
    acquireMultiplier?: [string, string | null, number][];
    adaPairMultiplier?: number;
    adaDistribution?: [string, string, number][];
    asset_window?: {
      start: number;
      end: number;
    };
    acquire_window?: {
      start: number;
      end: number;
    };
  }): Promise<{
    txSizeBytes: number;
    txSizeKB: number;
    maxSizeBytes: number;
    percentOfMax: number;
    withinLimit: boolean;
    multiplierCount: number;
    adaDistributionCount: number;
  }> {
    const {
      vault,
      vaultStatus,
      asset_window,
      acquire_window,
      acquireMultiplier = [],
      adaPairMultiplier = 0,
      adaDistribution = [],
    } = config;

    const assetsWhitelist = await this.assetsWhitelistRepository.find({
      where: { vault: { id: vault.id } },
      select: ['policy_id'],
    });

    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 4000000,
      validateUtxos: false,
    });

    const requiredInputs: string[] = [];

    const allowedPolicies: string[] =
      Array.isArray(assetsWhitelist) && assetsWhitelist.length > 0
        ? assetsWhitelist.map(policy => policy.policy_id)
        : [];
    const contract_type = vault.privacy === VaultPrivacy.private ? 0 : vault.privacy === VaultPrivacy.public ? 1 : 2;

    this.scAddress = getAddressFromHash(this.scPolicyId, this.networkId);

    const vaultUtxo = await getVaultUtxo(this.scPolicyId, vault.asset_vault_name, this.blockfrost);

    let vaultMessageStatus = '';
    if (vaultStatus === SmartContractVaultStatus.SUCCESSFUL) {
      vaultMessageStatus = 'Locked';
    } else if (vaultStatus === SmartContractVaultStatus.CANCELLED) {
      vaultMessageStatus = 'Failed';
    } else if (vaultStatus === SmartContractVaultStatus.OPEN) {
      vaultMessageStatus = 'Open';
    } else {
      vaultMessageStatus = 'Unknown';
    }

    const input = {
      changeAddress: this.adminAddress,
      message: `[TEST] Vault ${vault.id} ${vaultMessageStatus} Update Size Estimation`,
      utxos: adminUtxos,
      scriptInteractions: [
        {
          purpose: 'spend',
          outputRef: vaultUtxo,
          hash: this.scPolicyId,
          redeemer: {
            type: 'json',
            value: {
              vault_token_index: 0,
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
              vault_status: vaultStatus,
              contract_type: contract_type,
              asset_whitelist: allowedPolicies,
              asset_window: {
                lower_bound: {
                  bound_type: new Date(asset_window?.start || vault.contribution_phase_start).getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: new Date(
                    (asset_window?.end ? new Date(asset_window.end) : vault.contribution_phase_start).getTime() +
                      Number(vault.contribution_duration)
                  ).getTime(),
                  is_inclusive: true,
                },
              },
              acquire_window: {
                lower_bound: {
                  bound_type: acquire_window?.start ? new Date(acquire_window.start).getTime() : new Date().getTime(),
                  is_inclusive: true,
                },
                upper_bound: {
                  bound_type: acquire_window?.end ? new Date(acquire_window.end).getTime() : new Date().getTime(),
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

    try {
      // Build the transaction to get its size
      const buildResponse = await this.blockchainService.buildTransaction(input);

      // Calculate transaction size
      const txBytes = Buffer.from(buildResponse.complete, 'hex');
      const txSizeBytes = txBytes.length;
      const txSizeKB = +(txSizeBytes / 1024).toFixed(2);

      // Cardano max transaction size is 16KB (16384 bytes)
      const maxSizeBytes = 16384;
      const percentOfMax = +((txSizeBytes / maxSizeBytes) * 100).toFixed(2);
      const withinLimit = txSizeBytes <= maxSizeBytes;

      this.logger.log(
        `Transaction size estimation: ${txSizeBytes} bytes (${txSizeKB} KB) = ${percentOfMax}% of max. ` +
          `Multipliers: ${acquireMultiplier.length}, ADA Distribution: ${adaDistribution.length}, ` +
          `Within limit: ${withinLimit}`
      );

      return {
        txSizeBytes,
        txSizeKB,
        maxSizeBytes,
        percentOfMax,
        withinLimit,
        multiplierCount: acquireMultiplier.length,
        adaDistributionCount: adaDistribution.length,
      };
    } catch (error) {
      this.logger.error('Failed to estimate vault update tx size:', error);
      throw new Error(`Failed to estimate transaction size: ${error.message}`);
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

      if (this.systemSettingsService.vlrmCreatorFeeEnabled && this.systemSettingsService.vlrmCreatorFee > 0) {
        const vlrmAsset = this.assetsRepository.create({
          vault: { id: vault.id },
          policy_id: this.VLRM_POLICY_ID,
          asset_id: `${this.VLRM_POLICY_ID}${this.VLRM_HEX_ASSET_NAME}`,
          type: AssetType.FT,
          quantity: this.systemSettingsService.vlrmCreatorFee,
          status: AssetStatus.LOCKED,
          origin_type: AssetOriginType.FEE,
          decimals: 4, // VLRM has 4 decimal places
          name: 'VLRM',
          transaction: { id: signedTx.txId },
          added_by: { id: ownerId },
          image: 'ipfs://QmdYu513Bu7nfKV5LKP6cmpZ8HHXifQLH6FTTzv3VbbqwP', // VLRM logo
          metadata: {
            purpose: 'vault_creation_fee',
          },
        });

        await this.assetsRepository.save(vlrmAsset);

        this.logger.log(
          `Created VLRM asset record for vault ${vault.id}: ${this.systemSettingsService.vlrmCreatorFee} tokens`
        );
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
