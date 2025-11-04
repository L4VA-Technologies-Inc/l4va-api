import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { FixedTransaction, PlutusData, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { In, Repository } from 'typeorm';

import { ClaimResponseDto, ClaimResponseItemsDto } from './dto/claim-response.dto';
import { GetClaimsDto } from './dto/get-claims.dto';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { Vault } from '@/database/vault.entity';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { Datum, Redeemer, Redeemer1 } from '@/modules/vaults/processing-tx/onchain/types/type';
import { generate_tag_from_txhash_index } from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { AssetOriginType } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private blockfrost: BlockFrostAPI;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
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
  async getUserClaims(userId: string, query: GetClaimsDto): Promise<ClaimResponseDto> {
    const whereConditions: {
      user: { id: string };
      status?: ClaimStatus | ReturnType<typeof In>;
      type?: ClaimType | ReturnType<typeof In>;
    } = { user: { id: userId } };

    if (query?.status) {
      whereConditions.status = query.status;
    }

    if (query?.type) {
      if (query.type === ClaimType.DISTRIBUTION) {
        whereConditions.type = In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]);
      } else {
        whereConditions.type = query.type as ClaimType;
      }
    }

    if (query?.claimState === 'claimed') {
      whereConditions.status = ClaimStatus.CLAIMED;
    } else if (query?.claimState === 'unclaimed') {
      whereConditions.status = In([ClaimStatus.AVAILABLE, ClaimStatus.PENDING]);
    }

    const page = parseInt(query?.page as string) || 1;
    const limit = parseInt(query?.limit as string) || 10;
    const skip = (page - 1) * limit;

    const [claims, total] = await this.claimRepository.findAndCount({
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
      skip,
      take: limit,
    });

    const items = claims.map(claim => {
      const cleanClaim = {
        ...claim,
        amount: claim.amount / 10 ** (claim.vault?.ft_token_decimals || 0),
        vault: {
          ...claim.vault,
          vaultImage: claim.vault?.vault_image?.file_url || null,
        },
      };

      return plainToInstance(ClaimResponseItemsDto, cleanClaim, {
        excludeExtraneousValues: true,
      });
    });

    return { items, total, page, limit };
  }

  async createCancellationClaims(vault: Vault, reason: string): Promise<void> {
    const contributionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vault.id,
        type: TransactionType.contribute,
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
    });

    const acquisitionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vault.id,
        type: TransactionType.acquire,
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
    });

    const cancelClaims: Partial<Claim>[] = [];

    // Create cancellation claims for contributions (return assets)
    for (const tx of contributionTransactions) {
      if (!tx.user?.id) continue;

      try {
        const existingClaim = await this.claimRepository.exists({
          where: {
            transaction: { id: tx.id },
            type: ClaimType.CANCELLATION,
          },
        });

        if (existingClaim) {
          this.logger.log(`Cancellation claim already exists for transaction ${tx.id}`);
          continue;
        }

        // Get assets for this transaction
        const txAssets = await this.assetsRepository.find({
          where: {
            transaction: { id: tx.id },
            origin_type: AssetOriginType.CONTRIBUTED,
            deleted: false,
          },
        });

        if (txAssets.length === 0) continue;

        const claim = this.claimRepository.create({
          user: { id: tx.user.id },
          vault: { id: vault.id },
          type: ClaimType.CANCELLATION,
          status: ClaimStatus.AVAILABLE,
          description: `Return contributed assets from failed vault: ${vault.name}`,
          metadata: {
            transactionType: 'contribution',
            assets: txAssets.map(asset => ({
              id: asset.id,
              policyId: asset.policy_id,
              assetId: asset.asset_id,
              quantity: asset.quantity,
              type: asset.type,
            })),
            assetIds: txAssets.map(asset => asset.id),
            failureReason: reason,
            originalTxHash: tx.tx_hash,
            outputIndex: 0, // Assuming contribution UTXOs are at index 0
          },
          transaction: { id: tx.id },
        });
        cancelClaims.push(claim);
      } catch (error) {
        this.logger.error(`Failed to create cancellation claim for contribution ${tx.id}:`, error);
      }
    }

    // Create cancellation claims for acquisitions (return ADA)
    for (const tx of acquisitionTransactions) {
      if (!tx.user?.id || !tx.amount) continue;

      try {
        const existingClaim = await this.claimRepository.findOne({
          where: {
            transaction: { id: tx.id },
            type: ClaimType.CANCELLATION,
          },
        });

        if (existingClaim) {
          this.logger.log(`Cancellation claim already exists for transaction ${tx.id}`);
          continue;
        }

        const claim = this.claimRepository.create({
          user: { id: tx.user.id },
          vault: { id: vault.id },
          type: ClaimType.CANCELLATION,
          amount: tx.amount, // ADA amount to return
          status: ClaimStatus.AVAILABLE,
          description: `Return ADA from failed vault acquisition: ${vault.name}`,
          metadata: {
            transactionType: 'acquisition',
            adaAmount: tx.amount,
            failureReason: reason,
            originalTxHash: tx.tx_hash,
            outputIndex: 0,
          },
          transaction: { id: tx.id },
        });
        cancelClaims.push(claim);
      } catch (error) {
        this.logger.error(`Failed to create cancellation claim for acquisition ${tx.id}:`, error);
      }
    }

    // Save all claims
    if (cancelClaims.length > 0) {
      try {
        await this.claimRepository.save(cancelClaims);
        this.logger.log(`Created ${cancelClaims.length} cancellation claims for vault ${vault.id}`);
      } catch (error) {
        this.logger.error(`Failed to save cancellation claims for vault ${vault.id}:`, error);
      }
    }
  }

  async buildAndSubmitCancellationTransaction(claimId: string): Promise<{
    txHash: string;
    success: boolean;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId, type: ClaimType.CANCELLATION },
      relations: ['user', 'vault', 'transaction'],
    });

    if (!claim) {
      throw new NotFoundException('Cancellation claim not found');
    }

    if (claim.status !== ClaimStatus.AVAILABLE) {
      throw new BadRequestException('Cancellation claim is not available');
    }

    const { vault, user, transaction } = claim;

    if (transaction.type !== TransactionType.contribute && transaction.type !== TransactionType.acquire) {
      throw new BadRequestException('Transaction is not a contribution or acquisition');
    }

    const POLICY_ID = vault.script_hash;
    const lpsUnit = vault.script_hash + '72656365697074';
    const txUtxos = await this.blockfrost.txsUtxos(transaction.tx_hash);
    const output = txUtxos.outputs[0];
    if (!output) {
      throw new Error('No output found');
    }
    const amountOfLpsToClaim = output.amount.find((a: { unit: string; quantity: string }) => a.unit === lpsUnit);

    if (!amountOfLpsToClaim) {
      throw new Error('No lps to claim.');
    }

    const datumTag = generate_tag_from_txhash_index(transaction.tx_hash, 0);

    const refundAssets = [];
    let refundLovelace = 0;

    // Process ALL amounts from the original UTXO to build exact refund
    for (const amount of output.amount) {
      if (amount.unit === 'lovelace') {
        refundLovelace = parseInt(amount.quantity);
      } else if (amount.unit !== lpsUnit) {
        refundAssets.push({
          assetName: { name: amount.unit.slice(56), format: 'hex' },
          policyId: amount.unit.slice(0, 56),
          quantity: parseInt(amount.quantity),
        });
      }
      // Skip receipt token as it gets burned
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
      changeAddress: this.adminAddress,
      message: `Cancel ${transaction.type === TransactionType.contribute ? 'asset' : 'ADA'} contribution - return assets to contributor`,
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
            } satisfies Redeemer1,
          },
        },
        {
          purpose: 'mint',
          hash: POLICY_ID,
          redeemer: {
            type: 'json',
            value: 'CancelContribution' satisfies Redeemer,
          },
        },
      ],
      mint: [
        {
          version: 'cip25',
          assetName: { name: 'receipt', format: 'utf8' },
          policyId: POLICY_ID,
          type: 'plutus',
          quantity: -1, // Burn the receipt
          metadata: {},
        },
      ],
      outputs: [
        {
          address: user.address,
          assets: refundAssets.length > 0 ? refundAssets : undefined,
          lovelace: refundLovelace,
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
          index: 0,
        },
      ],
      validityInterval: {
        start: true,
        end: true,
      },
      network: 'preprod',
    };

    try {
      const buildResponse = await this.blockchainService.buildTransaction(input);
      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      // Create internal transaction record
      const internalTx = await this.transactionRepository.save({
        user_id: user.id,
        vault_id: vault.id,
        type: TransactionType.cancel,
        status: TransactionStatus.created,
      });

      // Submit transaction
      const response = await this.blockchainService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
      });

      if (!response.txHash) {
        throw new Error('Failed to submit cancellation transaction - no txHash returned');
      }

      // Update transaction with hash immediately
      await this.transactionRepository.update(
        { id: internalTx.id },
        { tx_hash: response.txHash, status: TransactionStatus.submitted }
      );

      this.logger.log(
        `Cancellation transaction ${response.txHash} submitted for claim ${claimId}, waiting for confirmation...`
      );

      // Wait for confirmation using blockchain service
      const confirmed = await this.blockchainService.waitForTransactionConfirmation(response.txHash);

      if (confirmed) {
        // Update transaction status to confirmed
        await this.transactionRepository.update({ id: internalTx.id }, { status: TransactionStatus.confirmed });

        this.logger.log(`Cancellation transaction ${response.txHash} confirmed for claim ${claimId}`);

        return {
          success: true,
          txHash: response.txHash,
        };
      } else {
        // Handle timeout
        await this.transactionRepository.update({ id: internalTx.id }, { status: TransactionStatus.failed });

        this.logger.warn(`Cancellation transaction ${response.txHash} confirmation timeout for claim ${claimId}`);

        // Still return success but with a warning - transaction was submitted
        return {
          success: true,
          txHash: response.txHash,
        };
      }
    } catch (error) {
      this.logger.error(`Failed to process cancellation transaction for claim ${claimId}:`, error);
      throw new Error(`Failed to submit cancellation transaction: ${error.message}`);
    }
  }

  /**
   * Updates the status of a claim with optional metadata
   *
   * @param claimId - The ID of the claim to update
   * @param status - The new status to set
   * @param metadata - Optional metadata to set
   * @returns Promise<void>
   */
  async updateClaimStatus(claimId: string, status: ClaimStatus, metadata?: Record<string, any>): Promise<void> {
    try {
      const updateData: Partial<Claim> = {
        status,
      };

      if (metadata) {
        const existingClaim = await this.claimRepository.findOne({
          where: { id: claimId },
          select: ['metadata'],
        });

        updateData.metadata = {
          ...(existingClaim?.metadata || {}),
          ...metadata,
        };
      }

      await this.claimRepository.update({ id: claimId }, updateData);
    } catch (error) {
      this.logger.error(`Failed to update claim ${claimId} status to ${status}:`, error);
    }
  }

  // async buildClaimTransaction(claimId: string): Promise<{
  //   success: boolean;
  //   transactionId: string;
  //   presignedTx: string;
  // }> {
  //   const claim = await this.claimRepository.findOne({
  //     where: { id: claimId },
  //     relations: ['user', 'vault', 'transaction'],
  //   });

  //   const vault = claim.vault;
  //   const user = claim.user;

  //   if (!claim) {
  //     throw new NotFoundException('Claim not found');
  //   }

  //   if (claim.status !== ClaimStatus.AVAILABLE && claim.status !== ClaimStatus.PENDING) {
  //     throw new Error('Claim is not available for extraction');
  //   }

  //   if (!vault || !user) {
  //     throw new Error('Vault or user not found for claim');
  //   }
  //   // return await this.claimAcquirer(claim, user, vault);
  // }
}
