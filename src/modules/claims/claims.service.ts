import { Buffer } from 'node:buffer';

import { FixedTransaction, PlutusData, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
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
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { Datum, Redeemer, Redeemer1 } from '@/modules/vaults/processing-tx/onchain/types/type';
import { applyContributeParams, toPreloadedScript } from '@/modules/vaults/processing-tx/onchain/utils/apply_params';
import blueprint from '@/modules/vaults/processing-tx/onchain/utils/blueprint.json';
import { generate_tag_from_txhash_index } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { ClaimStatus } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;
  private readonly adminHash: string;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
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
        tx_hash: true,
        description: true,
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
   * Build a transaction to extract LP tokens from a vault
   *
   * User press "claim" button
   *
   * Frontend send request to build tx of claim
   *
   * backend create internal tx, then backend create blockchain tx and connect both tx by txHash
   *
   * then backend sign blockchain tx with admin wallet, and return presigned tx to user
   *
   * then user sign presigned tx with his own wallet
   *
   * then tx send to backend and publish to blockchain
   *
   * then scanner call webhook with tx detail when tx will exist on chain.
   *
   * then using information txHash we will update internal tx and maybe claim status
   *
   * @param claimId - ID of the claim to process
   * @returns Object containing transaction details
   */
  async buildClaimTransaction(claimId: string): Promise<{
    success: boolean;
    transactionId: string;
    presignedTx: string;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId },
      relations: ['user', 'vault'],
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    if (claim.status !== ClaimStatus.AVAILABLE && claim.status !== ClaimStatus.PENDING) {
      throw new Error('Claim is not available for extraction');
    }

    // Update claim status to PENDING
    claim.status = ClaimStatus.PENDING;
    await this.claimRepository.save(claim);

    const parameterizedScript = applyContributeParams({
      vault_policy_id: 'd4915ac1dd9ef95493351cfaa2a6c9a85086472f12523999b5e32aeb',
      vault_id: claim.vault.asset_vault_name,
    });

    const unparameterizedScript = blueprint.validators.find(v => v.title === 'contribute.contribute');

    try {
      const vault = claim.vault;
      const user = claim.user;

      if (!vault || !user) {
        throw new Error('Vault or user not found for claim');
      }

      // Create internal transaction
      const internalTx = await this.transactionRepository.save({
        user_id: user.id,
        vault_id: vault.id,
        amount: claim.amount,
        type: TransactionType.claim,
        status: TransactionStatus.waitingOwner,
        metadata: {
          claimId: claim.id,
          createdAt: new Date().toISOString(),
          transactionType: 'claim',
          description: `Claim payout for user ${claim.user.id}`,
          utxoToClaim: claim.metadata?.utxoToClaim, // TX_HASH_INDEX_WITH_LPS_TO_COLLECT from metadata
          lastUpdateTxHash: vault.last_update_tx_hash,
          lastUpdateTxIndex: vault.last_update_tx_index,
          policyId: vault.policy_id,
          vaultId: vault.asset_vault_name,
          vtAmount: claim.amount,
        },
      });

      // Extract data from claim metadata
      const [txHash, txIndex] = claim.metadata.utxoToClaim.split('#');
      const datumTag = generate_tag_from_txhash_index(txHash, Number(txIndex));

      // Define the transaction input based on extract_lovelace.ts example
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
        message: 'Token Extraction',
        scriptInteractions: [
          {
            purpose: 'spend',
            hash: vault.policy_id,
            outputRef: {
              txHash: txHash,
              index: txIndex,
            },
            redeemer: {
              type: 'json',
              value: {
                __variant: 'ExtractAda',
                __data: {
                  vault_token_output_index: 0,
                },
              } satisfies Redeemer1,
            },
          },
          {
            purpose: 'mint',
            hash: vault.policy_id,
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
            policyId: vault.policy_id,
            type: 'plutus',
            quantity: claim.amount, // Use the amount from the claim
            metadata: {},
          },
        ],
        outputs: [
          {
            address: user.address,
            assets: [
              {
                assetName: { name: vault.asset_vault_name, format: 'hex' },
                policyId: vault.policy_id,
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

      // Build the transaction
      const buildResponse = await this.blockchainService.buildTransaction(input);
      this.logger.log('Transaction built successfully');

      // Sign the transaction with admin key
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      await this.transactionRepository.save(internalTx);

      return {
        success: true,
        transactionId: internalTx.id,
        presignedTx: txToSubmitOnChain.to_hex(),
      };
    } catch (error) {
      this.logger.error(`Failed to build LP extraction transaction: ${error.message}`, error);
      // Reset claim status on error
      claim.status = ClaimStatus.AVAILABLE;
      await this.claimRepository.save(claim);
      throw error;
    }
  }

  async submitSignedTransaction(
    transactionId: string,
    signedTxHex: string
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
      // Submit to blockchain
      const submitResponse = await this.blockchainService.submitTransaction({
        transaction: signedTxHex,
        signatures: [],
      });

      internalTx.tx_hash = submitResponse.txHash;
      internalTx.status = TransactionStatus.submitted;
      await this.transactionRepository.save(internalTx);

      // Update the claim status
      const claim = await this.claimRepository.findOne({
        where: { id: internalTx.metadata.claimId },
      });
      if (claim) {
        claim.status = ClaimStatus.CLAIMED;
        claim.tx_hash = submitResponse.txHash;
        await this.claimRepository.save(claim);
      }

      return {
        success: true,
        transactionId: internalTx.id,
        blockchainTxHash: submitResponse.txHash,
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
