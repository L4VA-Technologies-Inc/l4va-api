import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  Address,
  Credential,
  EnterpriseAddress,
  FixedTransaction,
  PlutusData,
  PrivateKey,
  ScriptHash,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Repository } from 'typeorm';

import { ClaimResponseDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { Datum, Redeemer, Redeemer1 } from '@/modules/vaults/processing-tx/onchain/types/type';
import { applyContributeParams, toPreloadedScript } from '@/modules/vaults/processing-tx/onchain/utils/apply_params';
import { generate_tag_from_txhash_index, getUtxosExctract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const blueprint = require('../vaults/processing-tx/onchain/utils/blueprint.json');

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;
  private readonly adminHash: string;
  private readonly vaultPolicyId: string;
  private blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.vaultPolicyId = this.configService.get<string>('SC_POLICY_ID');
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
  }

  /**
   * Retrieves claims for a specific user with optional filtering
   *
   * @param userId - The ID of the user whose claims to retrieve
   * @param query - Optional query parameters for filtering claims
   * @returns Promise with an array of Claim entities
   */
  async getUserClaims(userId: string, query?: GetClaimsDto): Promise<ClaimResponseDto[]> {
    const whereConditions: {
      user: { id: string };
      status?: ClaimStatus | ReturnType<typeof In>;
    } = { user: { id: userId } };

    if (query?.status) {
      whereConditions.status = query.status;
    }

    if (query?.claimState === 'claimed') {
      whereConditions.status = ClaimStatus.CLAIMED;
    } else if (query?.claimState === 'unclaimed') {
      whereConditions.status = In([ClaimStatus.AVAILABLE, ClaimStatus.PENDING]);
    }

    const claims = await this.claimRepository.find({
      where: whereConditions,
      order: { created_at: 'DESC' },
      relations: ['vault', 'vault.vault_image'],
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        description: true,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        metadata: true,
        created_at: true,
        updated_at: true,
        vault: {
          id: true,
          name: true,
        },
      },
    });

    return claims.map(claim => {
      const cleanClaim = {
        ...claim,
        vault: {
          id: claim.vault?.id,
          name: claim.vault?.name,
          image: claim.vault?.vault_image?.file_url || null,
        },
      };

      return plainToInstance(ClaimResponseDto, cleanClaim, {
        excludeExtraneousValues: true,
      });
    });
  }

  /**
   * Build a transaction to extract Ada or NFT from a vault
   *
   * → scanner call webhook with tx detail when tx will exist on chain.
   *
   * → using information txHash we will update internal tx and maybe claim status
   *
   * @param claimId - ID of the claim to process
   * @returns Object containing transaction details
   */
  async buildExctractTransaction(claimId: string): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['user', 'vault', 'transaction'],
    });

    const vault = claim.vault;
    const user = claim.user;

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    if (claim.status !== ClaimStatus.AVAILABLE && claim.status !== ClaimStatus.PENDING) {
      throw new Error('Claim is not available for extraction');
    }

    if (!vault || !user) {
      throw new Error('Vault or user not found for claim');
    }

    try {
      const utxos = await getUtxosExctract(Address.from_bech32(user.address), 0, this.blockfrost); // Any UTXO works.

      if (utxos.length === 0) {
        throw new Error('No UTXOs found.');
      }

      const parameterizedScript = applyContributeParams({
        vault_policy_id: this.vaultPolicyId,
        vault_id: claim.vault.asset_vault_name,
      });
      const POLICY_ID = parameterizedScript.validator.hash;

      const unparameterizedScript = blueprint.validators.find(v => v.title === 'contribute.contribute');

      if (!unparameterizedScript) {
        throw new Error('Contribute validator not found');
      }

      // Extract data from claim metadata
      const lpsUnit = parameterizedScript.validator.hash + '72656365697074';
      const txUtxos = await this.blockfrost.txsUtxos(claim.transaction.tx_hash);
      const output = txUtxos.outputs[0];
      if (!output) {
        throw new Error('No output found');
      }
      const amountOfLpsToClaim = output.amount.find((a: { unit: string; quantity: string }) => a.unit === lpsUnit);

      const datumTag = generate_tag_from_txhash_index(claim.transaction.tx_hash, Number(0));

      if (!amountOfLpsToClaim) {
        throw new Error('No lps to claim.');
      }

      const input: {
        changeAddress: string;
        utxos?: string[]; // FOR EXCTRACT ASSET TX
        message: string;
        mint?: Array<object>;
        scriptInteractions: object[];
        outputs: {
          address: string;
          assets?: object[];
          lovelace?: number;
          datum?: { type: 'inline'; value: string | Datum; shape?: object };
        }[];
        requiredSigners: string[];
        preloadedScripts: {
          type: string;
          blueprint: unknown;
        }[];
        referenceInputs: { txHash: string; index: number }[];
        validityInterval: {
          start: boolean;
          end: boolean;
        };
        network: string;
      } = {
        changeAddress: user.address,
        message: 'Admin extract asset',
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: POLICY_ID,
            outputRef: {
              txHash: claim.transaction.tx_hash,
              index: 0,
            },
            redeemer: {
              type: 'json',
              value: {
                __variant: claim.transaction.type === TransactionType.contribute ? 'ExtractAsset' : 'ExtractAda',
                __data: {
                  vault_token_output_index: 0,
                },
              } satisfies Redeemer1,
            },
          },
          {
            purpose: 'mint',
            hash: POLICY_ID,
            redeemer: {
              type: 'json',
              value: 'MintVaultToken' satisfies Redeemer,
            },
          },
        ],
        mint: [
          {
            version: 'cip25',
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: claim.amount, // Use the amount from the claim
            metadata: {},
          },
          {
            version: 'cip25',
            assetName: { name: 'receipt', format: 'utf8' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: -1,
            metadata: {},
          },
        ],
        outputs: [
          {
            address: user.address,
            assets: [
              {
                assetName: { name: vault.asset_vault_name, format: 'hex' },
                policyId: parameterizedScript.validator.hash,
                quantity: claim.amount,
              },
            ],
            datum: {
              type: 'inline',
              value: PlutusData.new_bytes(Buffer.from(datumTag, 'hex')).to_hex(),
            },
          },
        ],
        preloadedScripts: [
          toPreloadedScript(blueprint, {
            validators: [parameterizedScript.validator, unparameterizedScript],
          }),
        ],
        requiredSigners: [this.adminHash],
        referenceInputs: [
          {
            txHash: vault.last_update_tx_hash,
            index: vault.last_update_tx_index,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: 'preprod',
      };

      if (claim.transaction.type === TransactionType.contribute) {
        input['utxos'] = utxos;
      }

      // Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(input);
      this.logger.log('Transaction built successfully');

      // Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      // Create internal transaction
      const internalTx = await this.transactionRepository.save({
        user_id: user.id,
        vault_id: vault.id,
        type: TransactionType.extract,
        status: TransactionStatus.created,
      });

      await this.transactionRepository.save(internalTx);

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      this.logger.error(`Failed to build Claim extraction transaction: ${error.message}`, error);
      // Reset claim status on error
      claim.status = ClaimStatus.AVAILABLE;
      await this.claimRepository.save(claim);
      throw error;
    }
  }

  async buildClaimTransaction(claimId: string): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['user', 'vault', 'transaction'],
    });

    const vault = claim.vault;
    const user = claim.user;

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    if (claim.status !== ClaimStatus.AVAILABLE && claim.status !== ClaimStatus.PENDING) {
      throw new Error('Claim is not available for extraction');
    }

    if (!vault || !user) {
      throw new Error('Vault or user not found for claim');
    }

    try {
      const utxos = await getUtxosExctract(Address.from_bech32(user.address), 0, this.blockfrost); // Any UTXO works.

      if (utxos.length === 0) {
        throw new Error('No UTXOs found.');
      }

      const parameterizedScript = applyContributeParams({
        vault_policy_id: this.vaultPolicyId,
        vault_id: claim.vault.asset_vault_name,
      });
      const POLICY_ID = parameterizedScript.validator.hash;
      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID)))
        .to_address()
        .to_bech32();

      const unparameterizedScript = blueprint.validators.find(v => v.title === 'contribute.contribute');

      if (!unparameterizedScript) {
        throw new Error('Contribute validator not found');
      }

      // Extract data from claim metadata
      const lpsUnit = parameterizedScript.validator.hash + '72656365697074';
      const txUtxos = await this.blockfrost.txsUtxos(claim.transaction.tx_hash);
      const output = txUtxos.outputs[0];
      if (!output) {
        throw new Error('No output found');
      }
      this.logger.debug(txUtxos);
      this.logger.debug(lpsUnit);

      const amountOfLpsToClaim = output.amount.find((a: { unit: string; quantity: string }) => a.unit === lpsUnit);

      const datumTag = generate_tag_from_txhash_index(claim.transaction.tx_hash, Number(0));

      if (!amountOfLpsToClaim) {
        throw new Error('No lps to claim.');
      }

      const input: {
        changeAddress: string;
        message: string;
        mint?: Array<object>;
        scriptInteractions: object[];
        outputs: {
          address: string;
          assets?: object[];
          lovelace?: number;
          datum?: { type: 'inline'; value: string | Datum; shape?: object };
        }[];
        requiredSigners: string[];
        preloadedScripts: {
          type: string;
          blueprint: unknown;
        }[];
        referenceInputs: { txHash: string; index: number }[];
        validityInterval: {
          start: boolean;
          end: boolean;
        };
        network: string;
      } = {
        changeAddress: user.address,
        message: 'Claim LPs from ada contribution',
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: POLICY_ID,
            outputRef: {
              txHash: claim.transaction.tx_hash,
              index: 0,
            },
            redeemer: {
              type: 'json',
              value: { vault_token_output_index: 0, change_output_index: 1 },
            },
          },
          {
            purpose: 'mint',
            hash: POLICY_ID,
            redeemer: {
              type: 'json',
              value: 'MintVaultToken' satisfies Redeemer,
            },
          },
        ],
        mint: [
          {
            version: 'cip25',
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: claim.amount, // Use the amount from the claim
            metadata: {},
          },
          {
            version: 'cip25',
            assetName: { name: 'receipt', format: 'utf8' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: -1,
            metadata: {},
          },
        ],
        outputs: [
          {
            address: user.address,
            assets: [
              {
                assetName: { name: vault.asset_vault_name, format: 'hex' },
                policyId: parameterizedScript.validator.hash,
                quantity: claim.amount,
              },
            ],
            datum: {
              type: 'inline',
              value: PlutusData.new_bytes(Buffer.from(datumTag, 'hex')).to_hex(),
            },
          },
          {
            address: SC_ADDRESS,
            lovelace: 10000000,
            datum: {
              type: 'inline',
              value: {
                policy_id: POLICY_ID,
                asset_name: vault.asset_vault_name,
                owner: user.address,
              },
              shape: {
                validatorHash: POLICY_ID,
                purpose: 'spend',
              },
            },
          },
        ],
        preloadedScripts: [
          toPreloadedScript(blueprint, {
            validators: [parameterizedScript.validator, unparameterizedScript],
          }),
        ],
        requiredSigners: [this.adminHash],
        referenceInputs: [
          {
            txHash: vault.last_update_tx_hash,
            index: vault.last_update_tx_index,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: 'preprod',
      };

      const inputWithNoPreloaded = { ...input };
      delete inputWithNoPreloaded.preloadedScripts;
      this.logger.debug(JSON.stringify(inputWithNoPreloaded));

      // Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(input);
      this.logger.log('Transaction built successfully');

      // Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      // Create internal transaction
      const internalTx = await this.transactionRepository.save({
        user_id: user.id,
        vault_id: vault.id,
        // amount: claim.amount,
        type: TransactionType.extract,
        status: TransactionStatus.created,
      });

      await this.transactionRepository.save(internalTx);

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      this.logger.error(`Failed to build Claim extraction transaction: ${error.message}`, error);
      // Reset claim status on error
      claim.status = ClaimStatus.AVAILABLE;
      await this.claimRepository.save(claim);
      throw error;
    }
  }

  async submitSignedTransaction(
    transactionId: string,
    signedTx: { transaction: string; signatures: string | string[]; txId: string; claimId: string }
  ): Promise<{
    success: boolean;
    transactionId: string;
    blockchainTxHash: string;
  }> {
    // Find the internal transaction
    const internalTx = await this.transactionRepository.findOne({
      where: { id: transactionId },
    });

    if (!internalTx) {
      throw new NotFoundException('Transaction not found');
    }

    try {
      const signatures = Array.isArray(signedTx.signatures) ? signedTx.signatures : [signedTx.signatures];

      const result = await this.blockchainService.submitTransaction({
        transaction: signedTx.transaction,
        signatures,
      });

      internalTx.tx_hash = result.txHash;
      internalTx.status = TransactionStatus.submitted;
      await this.transactionRepository.save(internalTx);

      // Update the claim status
      try {
        const claim = await this.claimRepository.findOne({
          where: { id: signedTx.claimId },
        });
        if (claim) {
          claim.status = ClaimStatus.CLAIMED;
          await this.claimRepository.save(claim);
        }
      } catch (error) {
        this.logger.error(`Failed to update claim status: ${error.message}`, error);
      }

      return {
        success: true,
        transactionId: internalTx.id,
        blockchainTxHash: result.txHash,
      };
    } catch (error) {
      await this.transactionRepository.save(internalTx);
      throw error;
    }
  }

  async processConfirmedTransaction(txHash: string): Promise<void> {
    // Find the internal transaction by blockchain hash
    const internalTx = await this.transactionRepository.findOne({
      where: { tx_hash: txHash },
    });

    if (!internalTx) {
      this.logger.warn(`No internal transaction found for blockchain hash: ${txHash}`);
      return;
    }

    // Update transaction status
    internalTx.status = TransactionStatus.confirmed;
    await this.transactionRepository.save(internalTx);

    // Update the claim status
    if (internalTx.metadata?.claimId) {
      const claim = await this.claimRepository.findOne({
        where: { id: internalTx.metadata.claimId },
      });

      if (claim) {
        claim.status = ClaimStatus.CLAIMED;
        await this.claimRepository.save(claim);
        this.logger.log(`Claim ${claim.id} marked as CLAIMED with tx ${txHash}`);
      }
    }
  }
}
