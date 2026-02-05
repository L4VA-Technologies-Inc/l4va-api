import { Buffer } from 'node:buffer';

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, FixedTransaction, PlutusData, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
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
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { CancellationInput } from '@/modules/distribution/distribution.types';
import { TerminationService } from '@/modules/vaults/phase-management/governance/termination.service';
import { BlockchainService } from '@/modules/vaults/processing-tx/onchain/blockchain.service';
import { Redeemer, Redeemer1 } from '@/modules/vaults/processing-tx/onchain/types/type';
import {
  generate_tag_from_txhash_index,
  getTransactionSize,
  getUtxosExtract,
} from '@/modules/vaults/processing-tx/onchain/utils/lib';
import { AssetOriginType, AssetStatus } from '@/types/asset.types';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);
  private readonly adminSKey: string;
  private readonly adminAddress: string;
  private readonly adminHash: string;
  private readonly isMainnet: boolean;
  private blockfrost: BlockFrostAPI;
  private readonly MAX_TX_SIZE = 16360;

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    @InjectRepository(Claim)
    private claimRepository: Repository<Claim>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly blockchainService: BlockchainService,
    private readonly terminationService: TerminationService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.adminAddress = this.configService.get<string>('ADMIN_ADDRESS');
    this.adminHash = this.configService.get<string>('ADMIN_KEY_HASH');
    this.isMainnet = this.configService.get<string>('CARDANO_NETWORK') === 'mainnet';

    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_API_KEY'),
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
    const page = parseInt(query?.page as string) || 1;
    const limit = parseInt(query?.limit as string) || 10;
    const skip = (page - 1) * limit;

    if (
      query?.type === ClaimType.TERMINATION ||
      (Array.isArray(query?.type) && query?.type.includes(ClaimType.TERMINATION))
    ) {
      // Auto-create termination claims if user holds VT in terminating vaults
      await this.autoCreateTerminationClaims(userId);

      const terminationResult = await this.terminationService.getUserTerminationClaims(userId, skip, limit);

      // Transform termination claims to match ClaimResponseItemsDto format
      const items = terminationResult.claims.map(claim => {
        const cleanClaim = {
          id: claim.id,
          type: ClaimType.TERMINATION,
          status: claim.status as ClaimStatus,
          amount: parseFloat((claim.metadata as any)?.vtAmount) / 10 ** (claim.vault?.ft_token_decimals || 0),
          adaAmount:
            parseFloat((claim.metadata as any)?.adaAmount || claim.lovelace_amount?.toString() || '0') / 1_000_000,
          multiplier: null,
          description: null,
          createdAt: claim.created_at,
          updatedAt: claim.updated_at,
          vault: {
            id: claim.vault.id,
            name: claim.vault.name,
            vaultImage: claim.vault.vault_image?.file_url || null,
            vault_token_ticker: claim.vault?.vault_token_ticker || null,
            ft_token_decimals: claim.vault?.ft_token_decimals || null,
          },
        };

        return plainToInstance(ClaimResponseItemsDto, cleanClaim, {
          excludeExtraneousValues: true,
        });
      });

      return {
        items,
        total: terminationResult.total,
        page,
        limit,
      };
    }

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
        whereConditions.type = In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER, ClaimType.DISTRIBUTION]);
      } else {
        whereConditions.type = query.type as ClaimType;
      }
    }

    if (query?.claimState === 'claimed') {
      whereConditions.status = ClaimStatus.CLAIMED;
    } else if (query?.claimState === 'unclaimed') {
      whereConditions.status = In([ClaimStatus.AVAILABLE, ClaimStatus.PENDING]);
    }

    const [claims, total] = await this.claimRepository.findAndCount({
      where: whereConditions,
      order: { created_at: 'DESC' },
      relations: ['vault', 'vault.vault_image'],
      select: {
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
        id: claim.id,
        type: claim.type,
        status: claim.status,
        amount: claim.amount / 10 ** (claim.vault?.ft_token_decimals || 0),
        adaAmount: claim.lovelace_amount ? claim.lovelace_amount / 1_000_000 : null,
        multiplier: claim.multiplier,
        description: claim.description,
        createdAt: claim.created_at,
        updatedAt: claim.updated_at,
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

  /**
   * Auto-create termination claims for user if they hold VT in terminating vaults
   * This handles cases where VT was transferred after the initial snapshot
   */
  private async autoCreateTerminationClaims(userId: string): Promise<void> {
    try {
      // Get user address
      const user = await this.userRepository.findOne({
        where: { id: userId },
        select: ['id', 'address'],
      });

      if (!user?.address) {
        return;
      }

      // Get all vaults that have termination metadata (are in termination process)
      const terminatingVaults: Pick<
        Vault,
        'id' | 'name' | 'script_hash' | 'asset_vault_name' | 'termination_metadata'
      >[] = await this.vaultRepository
        .createQueryBuilder('vault')
        .where('vault.termination_metadata IS NOT NULL')
        .andWhere("vault.termination_metadata->>'status' IN (:...statuses)", {
          statuses: ['claims_created', 'claims_processing'],
        })
        .select(['vault.id', 'vault.name', 'vault.script_hash', 'vault.asset_vault_name', 'vault.termination_metadata'])
        .getMany();

      // For each vault, check if user holds VT and create/update claim if needed
      for (const vault of terminatingVaults) {
        try {
          // This method will:
          // 1. Check user's current VT balance
          // 2. If balance > 0 and no unclaimed claim exists, create new claim
          // 3. If unclaimed claim exists but amount changed, update it
          // 4. If claimed but user has more VT now, create additional claim
          const result = await this.terminationService.requestTerminationClaim(vault.id, user.address, userId);

          if (result.isNewClaim) {
            this.logger.log(`Auto-created termination claim for user ${userId} in vault ${vault.id}`);
          } else {
            this.logger.log(`Verified existing termination claim for user ${userId} in vault ${vault.id}`);
          }
        } catch (error) {
          // If user doesn't hold VT, clean up any old termination claims for this vault
          if (error.message?.includes('No VT balance found')) {
            const oldClaims = await this.claimRepository
              .createQueryBuilder('claim')
              .where('claim.user_id = :userId', { userId })
              .andWhere('claim.vault_id = :vaultId', { vaultId: vault.id })
              .andWhere('claim.type = :type', { type: ClaimType.TERMINATION })
              .andWhere('claim.status = :status', { status: ClaimStatus.AVAILABLE })
              .getMany();

            if (oldClaims.length > 0) {
              await this.claimRepository.remove(oldClaims);
              this.logger.log(
                `Removed ${oldClaims.length} old termination claim(s) for user ${userId} in vault ${vault.id} (no longer holds VT)`
              );
            }
          } else {
            this.logger.debug(`Could not auto-create claim for vault ${vault.id}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      // Log but don't throw - this is a background operation
      this.logger.error(`Error auto-creating termination claims for user ${userId}:`, error.stack);
    }
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
              quantity: asset.quantity.toString(),
              type: asset.type,
            })),
            failureReason: reason,
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
          continue;
        }

        const claim = this.claimRepository.create({
          user: { id: tx.user.id },
          vault: { id: vault.id },
          type: ClaimType.CANCELLATION,
          lovelace_amount: tx.amount, // ADA amount to return
          status: ClaimStatus.AVAILABLE,
          description: `Return ADA from failed vault acquisition: ${vault.name}`,
          metadata: {
            transactionType: 'acquisition',
            failureReason: reason,
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

  async buildAndSubmitBatchCancellationTransaction(claimIds: string[]): Promise<{
    txHash: string;
    success: boolean;
    processedClaims: string[];
  }> {
    if (claimIds.length === 0) {
      throw new BadRequestException('Must provide at least 1 claim ID for batch processing');
    }

    this.logger.debug(`Building batch cancellation transaction for  ${claimIds.length} claims: ${claimIds.join(', ')}`);

    // Fetch all claims with relations
    const claims = await this.claimRepository.find({
      where: {
        id: In(claimIds),
        type: ClaimType.CANCELLATION,
        status: ClaimStatus.AVAILABLE,
      },
      relations: ['user', 'vault', 'transaction'],
    });

    if (claims.length !== claimIds.length) {
      throw new NotFoundException('One or more cancellation claims not found or not available');
    }

    // ADD UTXO VALIDATION HERE
    const { validClaims } = await this.validateClaimUtxos(claims);

    if (validClaims.length === 0) {
      throw new BadRequestException('All cancellation claims have invalid or already-spent UTXOs');
    }

    // Validate all VALID claims belong to the same vault
    const vaultId = validClaims[0].vault.id;
    if (!validClaims.every(claim => claim.vault.id === vaultId)) {
      throw new BadRequestException('All claims must belong to the same vault');
    }

    const { utxos: adminUtxos } = await getUtxosExtract(Address.from_bech32(this.adminAddress), this.blockfrost, {
      minAda: 4000000,
    });

    const vault = validClaims[0].vault;
    const POLICY_ID = vault.script_hash;
    const lpsUnit = vault.script_hash + '72656365697074';

    const scriptInteractions: any[] = [];
    const outputs: any[] = [];
    const mintAssets: any[] = [];
    let totalReceiptsToburn = 0;

    // Process each claim
    for (let i = 0; i < validClaims.length; i++) {
      const claim = validClaims[i];
      const { user, transaction } = claim;

      if (transaction.type !== TransactionType.contribute && transaction.type !== TransactionType.acquire) {
        throw new BadRequestException(`Transaction ${transaction.id} is not a contribution or acquisition`);
      }

      // Get UTXO data for this transaction
      const txUtxos = await this.blockfrost.txsUtxos(transaction.tx_hash);
      const output = txUtxos.outputs[0];
      if (!output) {
        throw new Error(`No output found for transaction ${transaction.tx_hash}`);
      }

      const amountOfLpsToClaim = output.amount.find((a: { unit: string; quantity: string }) => a.unit === lpsUnit);
      if (!amountOfLpsToClaim) {
        throw new Error(`No LPs to claim for transaction ${transaction.tx_hash}`);
      }

      // Build refund assets and lovelace for this claim
      const refundAssets: any[] = [];
      let refundLovelace = 0;

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
      }

      const datumTag = generate_tag_from_txhash_index(transaction.tx_hash, 0);

      // Add script interaction for spending this UTXO
      scriptInteractions.push({
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
              cancel_output_index: i, // Use claim index as output index
            },
          } satisfies Redeemer1,
        },
      });

      // Add output for this claim's refund
      outputs.push({
        address: user.address,
        assets: refundAssets.length > 0 ? refundAssets : undefined,
        lovelace: refundLovelace,
        datum: {
          type: 'inline',
          value: PlutusData.new_bytes(Buffer.from(datumTag, 'hex')).to_hex(),
        },
      });

      totalReceiptsToburn++;
    }

    // Add mint script interaction (single one for all burns)
    scriptInteractions.push({
      purpose: 'mint',
      hash: POLICY_ID,
      redeemer: {
        type: 'json',
        value: 'CancelContribution' satisfies Redeemer,
      },
    });

    // Add mint instruction to burn all receipts
    mintAssets.push({
      version: 'cip25',
      assetName: { name: 'receipt', format: 'utf8' },
      policyId: POLICY_ID,
      type: 'plutus',
      quantity: -totalReceiptsToburn, // Burn all receipts in one go
      metadata: {},
    });

    const input: CancellationInput = {
      changeAddress: this.adminAddress,
      message: `Batch cancel ${claims.length} claims - return assets to contributors`,
      scriptInteractions,
      utxos: adminUtxos,
      mint: mintAssets,
      outputs,
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
      network: this.isMainnet ? 'mainnet' : 'preprod',
    };

    try {
      const buildResponse = await this.blockchainService.buildTransaction(input);
      const actualTxSize = getTransactionSize(buildResponse.complete);
      this.logger.debug(`Transaction size: ${actualTxSize} bytes (${(actualTxSize / 1024).toFixed(2)} KB)`);

      if (actualTxSize > this.MAX_TX_SIZE) {
        throw new Error(
          `Transaction size ${actualTxSize} bytes exceeds safe limit (${this.MAX_TX_SIZE} bytes). ` +
            `Reduce batch size.`
        );
      }

      const txToSubmitOnChain = FixedTransaction.from_bytes(Buffer.from(buildResponse.complete, 'hex'));
      txToSubmitOnChain.sign_and_add_vkey_signature(PrivateKey.from_bech32(this.adminSKey));

      const response = await this.blockchainService.submitTransaction({
        transaction: txToSubmitOnChain.to_hex(),
      });

      if (response.txHash) {
        // Store cancellation transaction for webhook tracking
        await this.transactionRepository.save({
          tx_hash: response.txHash,
          type: TransactionType.cancel,
          status: TransactionStatus.pending,
          vault_id: vault.id,
          metadata: {
            cancellationClaimIds: validClaims.map(c => c.id),
            claimCount: validClaims.length,
            processedAt: new Date().toISOString(),
          },
        });

        this.logger.log(
          `Batch cancellation transaction submitted for ${validClaims.length} claims: ${response.txHash}`
        );

        return {
          success: true,
          txHash: response.txHash,
          processedClaims: validClaims.map(c => c.id),
        };
      }
    } catch (error) {
      this.logger.error(`Failed to build/submit batch cancellation transaction: ${error.message}`);
      throw error;
    }
  }

  /**
   * Updates the status of one or more claims with optional metadata and distribution tx
   *
   * @param claimIds - Array of claim IDs to update (can be single item)
   * @param status - The new status to set for all claims
   * @param options - Optional object containing metadata and/or distributionTxId
   * @returns Promise<void>
   */
  async updateClaimStatus(
    claimIds: string | string[],
    status: ClaimStatus,
    options?: {
      metadata?: Record<string, any>;
      distributionTxId?: string;
    }
  ): Promise<void> {
    const claimIdArray = Array.isArray(claimIds) ? claimIds : [claimIds];

    if (claimIdArray.length === 0) {
      return;
    }

    try {
      if (options?.metadata) {
        // If metadata is provided, we need to merge it with existing metadata for each claim
        const existingClaims = await this.claimRepository.find({
          where: { id: In(claimIdArray) },
          select: ['id', 'metadata'],
        });

        if (!existingClaims.length) {
          this.logger.warn(`No claims found for IDs: ${claimIdArray.join(', ')}`);
          return;
        }

        const updates = existingClaims.map(claim => ({
          id: claim.id,
          status,
          metadata: {
            ...(claim.metadata || {}),
            ...options.metadata,
          },
          ...(options.distributionTxId && { distribution_tx_id: options.distributionTxId }),
        }));

        await this.claimRepository.save(updates);
        this.logger.log(
          `Updated ${existingClaims.length} claims status to ${status} with metadata` +
            (options.distributionTxId ? ` and distribution tx ${options.distributionTxId}` : '')
        );
      } else {
        // If no metadata, simple bulk update
        const updateData: Partial<Claim> = { status };

        if (options?.distributionTxId) {
          updateData.distribution_tx_id = options.distributionTxId;
        }

        await this.claimRepository.update({ id: In(claimIdArray) }, updateData);
        this.logger.log(
          `Updated ${claimIdArray.length} claims status to ${status}` +
            (options?.distributionTxId ? ` with distribution tx ${options.distributionTxId}` : '')
        );
      }
    } catch (error) {
      this.logger.error(`Failed to update ${claimIdArray.length} claims status to ${status}:`, error);
      throw error;
    }
  }

  /**
   * Validates that claim UTXOs exist and are unspent
   * Automatically marks already-spent UTXOs as CLAIMED
   *
   * @param claims - Array of claims to validate
   * @param skipStatusUpdate - If true, don't update invalid claims (useful for cancellations where you want to handle separately)
   * @returns Object containing valid and invalid claims with details
   */
  async validateClaimUtxos(
    claims: Claim[],
    skipStatusUpdate: boolean = false
  ): Promise<{
    validClaims: Claim[];
    invalidClaims: Array<{
      claim: Claim;
      reason: 'no_tx_hash' | 'no_output' | 'already_consumed' | 'error';
      details?: string;
    }>;
  }> {
    const validClaims: Claim[] = [];
    const invalidClaims: Array<{
      claim: Claim;
      reason: 'no_tx_hash' | 'no_output' | 'already_consumed' | 'error';
      details?: string;
    }> = [];

    for (const claim of claims) {
      const originalTx = claim.transaction;

      if (!originalTx || !originalTx.tx_hash) {
        this.logger.warn(`Claim ${claim.id} has no transaction hash`);
        invalidClaims.push({
          claim,
          reason: 'no_tx_hash',
        });
        continue;
      }

      try {
        const utxoDetails = await this.blockfrost.txsUtxos(originalTx.tx_hash);
        const outputIndex = (claim.metadata as any)?.outputIndex ?? 0; // Allow configurable output index
        const output = utxoDetails.outputs[outputIndex];

        if (!output) {
          this.logger.warn(`No output found for claim ${claim.id} at ${originalTx.tx_hash}#${outputIndex}`);
          invalidClaims.push({
            claim,
            reason: 'no_output',
            details: `Output index ${outputIndex} not found`,
          });
          continue;
        }

        if (output.consumed_by_tx) {
          this.logger.warn(
            `UTXO for claim ${claim.id} already consumed by ${output.consumed_by_tx}. ` +
              `Marking as already processed.`
          );
          invalidClaims.push({
            claim,
            reason: 'already_consumed',
            details: output.consumed_by_tx,
          });
          continue;
        }

        // UTXO is valid and unspent
        validClaims.push(claim);
      } catch (error) {
        this.logger.error(`Error checking UTXO for claim ${claim.id}:`, error);
        invalidClaims.push({
          claim,
          reason: 'error',
          details: error.message,
        });
      }
    }

    // Automatically handle already-consumed UTXOs (unless explicitly skipped)
    if (!skipStatusUpdate && invalidClaims.length > 0) {
      const alreadyConsumedClaims = invalidClaims.filter(ic => ic.reason === 'already_consumed').map(ic => ic.claim);

      if (alreadyConsumedClaims.length > 0) {
        this.logger.log(
          `Found ${alreadyConsumedClaims.length} claims with already-spent UTXOs. ` +
            `Marking as CLAIMED: ${alreadyConsumedClaims.map(c => c.id).join(', ')}`
        );

        await this.updateClaimStatus(
          alreadyConsumedClaims.map(c => c.id),
          ClaimStatus.CLAIMED,
          { metadata: { autoMarkedReason: 'utxo_already_consumed' } }
        );

        // Mark assets as distributed for acquirer claims
        for (const claim of alreadyConsumedClaims) {
          if (claim.type === ClaimType.ACQUIRER) {
            try {
              await this.assetsRepository.update(
                { transaction: { id: claim.transaction.id } },
                { status: AssetStatus.DISTRIBUTED }
              );
            } catch (error) {
              this.logger.error(`Failed to mark assets as distributed for claim ${claim.id}:`, error);
            }
          }
        }
      }
    }

    this.logger.log(`UTXO Validation complete: ${validClaims.length} valid, ${invalidClaims.length} invalid claims`);

    return { validClaims, invalidClaims };
  }
}
