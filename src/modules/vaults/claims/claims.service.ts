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
import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Repository } from 'typeorm';

import { ClaimResponseDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';

import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetsService } from '@/modules/vaults/processing-tx/assets/assets.service';
import { BlockchainService, TransactionBuildResponse } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { Datum, Redeemer, Redeemer1 } from '@/modules/vaults/processing-tx/onchain/types/type';
import { generate_tag_from_txhash_index, getUtxosExctract } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;
  private readonly adminHash: string;
  private blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    private readonly configService: ConfigService,
    private readonly assetService: AssetsService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
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
          vault_token_ticker: true,
          ft_token_decimals: true,
        },
      },
    });

    return claims.map(claim => {
      const cleanClaim = {
        ...claim,
        amount: claim.amount / 10 ** (claim.vault?.ft_token_decimals || 0),
        vault: {
          ...claim.vault,
          vaultImage: claim.vault?.vault_image?.file_url || null,
        },
      };

      return plainToInstance(ClaimResponseDto, cleanClaim, {
        excludeExtraneousValues: true,
      });
    });
  }

  /**
   * Extract = Keep assets in vault + mint vault tokens + burn receipt (admin-initiated, after window)
   *
   * @param claimId - ID of the claim to process
   * @returns Object containing transaction details
   */
  async buildExtractTransaction(claimId: string): Promise<{
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

      const POLICY_ID = vault.script_hash;
      const lpsUnit = vault.script_hash + '72656365697074';
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
                policyId: vault.script_hash,
                quantity: claim.amount,
              },
            ],
            datum: {
              type: 'inline',
              value: PlutusData.new_bytes(Buffer.from(datumTag, 'hex')).to_hex(),
            },
          },
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

  /**
   * Cancel = Return assets to contributor + burn receipt (contributor-initiated, during window)
   */
  async buildCancelTransaction(claimId: string): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    this.logger.log(`Building cancel transaction for claim ${claimId}`);

    try {
      const claim = await this.claimRepository.findOne({
        where: { id: claimId },
        relations: ['user', 'vault', 'transaction'],
      });

      if (!claim) {
        throw new NotFoundException(`Claim with ID ${claimId} not found`);
      }

      const { vault, user, transaction } = claim;

      if (claim.status !== ClaimStatus.AVAILABLE && claim.status !== ClaimStatus.PENDING) {
        throw new BadRequestException(`Claim is not available for cancellation (current status: ${claim.status})`);
      }

      if (!vault || !user) {
        throw new BadRequestException('Vault or user not found for claim');
      }

      const POLICY_ID = vault.script_hash;

      const input = {
        changeAddress: user.address,
        message: 'Cancel asset contribution',
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: POLICY_ID,
            outputRef: {
              txHash: transaction.tx_hash,
              index: 0,
            },
            redeemer: {
              type: 'json',
              value: {
                __variant: 'CancelAsset',
                __data: {
                  cancel_output_index: 0,
                },
              },
            },
          },
          {
            purpose: 'mint',
            hash: POLICY_ID,
            redeemer: {
              type: 'json',
              value: 'CancelContribution',
            },
          },
        ],
        mint: [
          {
            version: 'cip25',
            assetName: { name: 'receipt', format: 'utf8' },
            policyId: POLICY_ID,
            type: 'plutus',
            quantity: -1,
            metadata: {},
          },
        ],
        outputs: [], // Outputs are determined automatically by cardano-cli
        requiredSigners: [this.adminHash],
        referenceInputs: [
          {
            txHash: vault.last_update_tx_hash || vault.publication_hash,
            index: vault.last_update_tx_hash ? vault.last_update_tx_index : 0,
          },
        ],
        validityInterval: {
          start: true,
          end: true,
        },
        network: 'preprod',
      };

      const buildResponse = await this.blockchainService.buildTransaction(input);

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const internalTx = await this.transactionRepository.save({
        user_id: user.id,
        vault_id: vault.id,
        type: TransactionType.cancel,
        status: TransactionStatus.created,
      });

      claim.status = ClaimStatus.PENDING;
      await this.claimRepository.save(claim);

      this.logger.log(`Successfully built cancel transaction for claim ${claimId}`);

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      this.logger.error(`Failed to build cancel transaction for claim ${claimId}:`, error);

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      throw new Error(`Failed to build cancel transaction: ${error.message}`);
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
    if (claim.type === ClaimType.ACQUIRER) {
      return await this.claimAcquirer(claim, user, vault);
    } else if (claim.type === ClaimType.CONTRIBUTOR) {
      return await this.claimContributor(claim, user, vault);
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

      if (internalTx.type === TransactionType.cancel) {
        const claim = await this.claimRepository.findOne({
          where: { id: signedTx.claimId },
          select: ['id', 'metadata', 'type'],
        });

        if (claim && claim.metadata) {
          if (claim.type === ClaimType.FINAL_DISTRIBUTION && claim.metadata.isContribution && claim.metadata.assetIds) {
            for (const assetId of claim.metadata.assetIds) {
              try {
                // Update asset status in database
                await this.assetService.cancelAsset(assetId, claim.user_id);
                this.logger.log(`Asset ${assetId} marked as deleted after cancellation`);
              } catch (assetError) {
                this.logger.error(`Failed to mark asset ${assetId} as deleted:`, assetError);
              }
            }
          }
        }
      }

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

  private async claimAcquirer(
    claim: Claim,
    user: User,
    vault: Vault
  ): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    try {
      const utxos = await getUtxosExctract(Address.from_bech32(user.address), 0, this.blockfrost); // Any UTXO works.

      if (utxos.length === 0) {
        throw new Error('No UTXOs found.');
      }

      const POLICY_ID = vault.script_hash;

      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID)))
        .to_address()
        .to_bech32();

      // Extract data from claim metadata
      const lpsUnit = vault.script_hash + '72656365697074';
      const txUtxos = await this.blockfrost.txsUtxos(claim.transaction.tx_hash);
      const output = txUtxos.outputs[0];
      if (!output) {
        throw new Error('No output found');
      }
      const lovelaceChange = Number(output.amount.find(a => a.unit === 'lovelace')?.quantity ?? '0');
      const amountOfLpsToClaim = output.amount.find(a => a.unit === lpsUnit);
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
        referenceInputs: { txHash: string; index: number }[];
        validityInterval: {
          start: boolean;
          end: boolean;
        };
        network: string;
      } = {
        changeAddress: user.address,
        message: 'Claim VTs from ADA contribution',
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
                __variant: 'CollectVaultToken',
                __data: {
                  vault_token_output_index: 0,
                  change_output_index: 1,
                },
              },
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
                policyId: vault.script_hash,
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
            lovelace: lovelaceChange,
            datum: {
              type: 'inline',
              value: {
                policy_id: POLICY_ID,
                asset_name: vault.asset_vault_name,
                owner: user.address,
                datum_tag: datumTag,
              },
              shape: { validatorHash: POLICY_ID, purpose: 'spend' },
            },
          },
          // this caused -50 ada from account on acquire claim
          // {
          //   address: SC_ADDRESS,
          //   lovelace: 50000000,
          //   datum: {
          //     type: 'inline',
          //     value: {
          //       policy_id: POLICY_ID,
          //       asset_name: vault.asset_vault_name,
          //       owner: user.address,
          //     },
          //     shape: {
          //       validatorHash: POLICY_ID,
          //       purpose: 'spend',
          //     },
          //   },
          // },
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
        type: TransactionType.claim,
        status: TransactionStatus.created,
      });

      await this.transactionRepository.save(internalTx);

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      // Reset claim status on error
      claim.status = ClaimStatus.AVAILABLE;
      await this.claimRepository.save(claim);
      throw error;
    }
  }

  private async claimContributor(
    claim: Claim,
    user: User,
    vault: Vault
  ): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    try {
      const utxos = await getUtxosExctract(Address.from_bech32(user.address), 0, this.blockfrost); // Any UTXO works.

      if (utxos.length === 0) {
        throw new Error('No UTXOs found.');
      }

      const POLICY_ID = vault.script_hash;
      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID)))
        .to_address()
        .to_bech32();

      const lpsUnit = vault.script_hash + '72656365697074';
      const txUtxos = await this.blockfrost.txsUtxos(claim.transaction.tx_hash);
      const output = txUtxos.outputs[0];
      if (!output) {
        throw new Error('No output found');
      }
      const lovelaceChange = Number(output.amount.find(a => a.unit === 'lovelace')?.quantity ?? '0');
      const amountOfLpsToClaim = output.amount.find(a => a.unit === lpsUnit);
      const otherAssets = output.amount
        .filter(a => a.unit !== 'lovelace' && !a.unit.startsWith(POLICY_ID))
        .map(a => {
          const unit: string = a.unit;
          const policyId = unit.slice(0, 56);
          const assetNameHex = unit.slice(56);
          return {
            policyId,
            assetName: { name: assetNameHex, format: 'hex' },
            quantity: a.quantity,
          };
        });
      let lpQuantity = claim.amount.toString();

      if (!amountOfLpsToClaim) {
        throw new Error('No lps to claim.');
      }

      const buildPayload = (lpQty: string) => {
        const datumTagHex = generate_tag_from_txhash_index(claim.transaction.tx_hash, Number(0));

        const ownerOutput = {
          address: user.address,
          assets: [
            {
              assetName: { name: vault.asset_vault_name, format: 'hex' },
              policyId: POLICY_ID,
              quantity: lpQty,
            },
          ],
          datum: {
            type: 'inline' as const,
            value: PlutusData.new_bytes(Buffer.from(datumTagHex, 'hex')).to_hex(),
          },
        };

        const changeOutput = {
          address: SC_ADDRESS,
          lovelace: lovelaceChange,
          assets: otherAssets.length ? otherAssets : undefined,
          datum: {
            type: 'inline' as const,
            value: {
              policy_id: POLICY_ID,
              asset_name: vault.asset_vault_name,
              owner: user.address,
              datum_tag: datumTagHex,
            },
            shape: { validatorHash: POLICY_ID, purpose: 'spend' },
          },
        };

        const mint = [
          {
            version: 'cip25' as const,
            policyId: POLICY_ID,
            assetName: { name: vault.asset_vault_name, format: 'hex' },
            type: 'plutus',
            quantity: lpQty,
          },
          {
            version: 'cip25' as const,
            policyId: POLICY_ID,
            assetName: { name: 'receipt', format: 'utf8' },
            type: 'plutus',
            quantity: -1,
          },
        ];

        const payload = {
          changeAddress: user.address,
          message: 'Claim VTs from asset contribution',
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
                  __variant: 'CollectVaultToken',
                  __data: { vault_token_output_index: 0, change_output_index: 1 },
                },
              },
            },
            {
              purpose: 'mint',
              hash: POLICY_ID,
              redeemer: { type: 'json', value: 'MintVaultToken' as Redeemer },
            },
          ],
          mint,
          outputs: [ownerOutput, changeOutput],
          requiredSigners: [this.adminHash],
          referenceInputs: [{ txHash: vault.last_update_tx_hash, index: vault.last_update_tx_index }],
          validityInterval: { start: true, end: true },
          network: 'preprod',
        };

        return payload;
      };

      const tryBuild = async (lpQty: string): Promise<TransactionBuildResponse> => {
        const payload = buildPayload(lpQty);
        const buildResponse = await this.blockchainService.buildTransaction(payload);
        return buildResponse;
      };

      const build1 = await tryBuild(lpQuantity);

      if (!build1?.complete) {
        const traced = this.parseTracesForExpectedLP(build1, POLICY_ID, vault.asset_vault_name);
        if (traced) {
          lpQuantity = traced;
          const build2 = await tryBuild(lpQuantity);
          if (!build2?.complete) {
            this.logger.error('Build failed. See traces above.');
            return;
          } else {
            const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(build2.complete, 'hex'));
            txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

            // Create internal transaction
            const internalTx = await this.transactionRepository.save({
              user_id: user.id,
              vault_id: vault.id,
              // amount: claim.amount,
              type: TransactionType.claim,
              status: TransactionStatus.created,
            });

            await this.transactionRepository.save(internalTx);

            return {
              success: true,
              transactionId: internalTx.id,
              presignedTx: txToSubmitOnChain.to_hex(),
            };
          }
        } else {
          this.logger.error('Could not extract expected LP from traces.');
          this.logger.error('Build failed. See traces above.');
          return;
        }
      } else {
        // Sign the transaction with admin key
        const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(build1.complete, 'hex'));
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
      }
    } catch (error) {
      // Reset claim status on error
      claim.status = ClaimStatus.AVAILABLE;
      await this.claimRepository.save(claim);
      throw error;
    }
  }

  private parseTracesForExpectedLP(msg: any, policyId: string, assetHex: string): string | null {
    try {
      const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
      const rx = new RegExp(
        String.raw`h'${policyId.toUpperCase()}'\s*:\s*{\s*_ h'${assetHex.toUpperCase()}'\s*:\s*([0-9]+)`,
        'm'
      );
      const m = text.match(rx);
      if (m && m[1]) return m[1];
      return null;
    } catch {
      return null;
    }
  }
}
