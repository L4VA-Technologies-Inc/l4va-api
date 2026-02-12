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
import { VerifyClaimsQueryDto } from './dto/verify-claims-query.dto';
import {
  ClaimDiscrepancy,
  ClaimVerificationSummary,
  VaultCalculationContext,
  VerifyClaimsResponseDto,
} from './dto/verify-claims.dto';

import { Asset } from '@/database/asset.entity';
import { Claim } from '@/database/claim.entity';
import { Transaction } from '@/database/transaction.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { DistributionCalculationService } from '@/modules/distribution/distribution-calculation.service';
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
    private readonly terminationService: TerminationService,
    private readonly distributionCalculationService: DistributionCalculationService
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
          const noVtBalanceError =
            error.message?.includes('No VT balance found') ||
            error.message?.includes('no VT balance') ||
            error.message?.includes('must hold vault tokens');

          if (noVtBalanceError) {
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

  /**
   * Verify vault claims by recalculating from transactions and comparing with database
   * Shows rounding differences and discrepancies between expected and actual amounts
   *
   * @param vaultId - The ID of the vault to verify claims for
   * @param query - Optional filters for user address or ID
   * @returns Detailed verification report with discrepancies
   */
  async verifyClaims(vaultId: string, query?: VerifyClaimsQueryDto): Promise<VerifyClaimsResponseDto> {
    this.logger.log(`Starting claims verification for vault ${vaultId}`);

    // 1. Fetch vault with metadata
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    // 2. Fetch all claims for the vault
    const allClaims = await this.claimRepository.find({
      where: {
        vault: { id: vaultId },
        type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER, ClaimType.LP]),
      },
      relations: ['transaction', 'transaction.assets', 'transaction.user', 'user'],
      order: { created_at: 'ASC' },
    });

    // 3. Fetch all transactions
    const acquisitionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vaultId,
        type: TransactionType.acquire,
        status: TransactionStatus.confirmed,
      },
      relations: ['user'],
      order: { created_at: 'ASC' },
    });

    const contributionTransactions = await this.transactionRepository.find({
      where: {
        vault_id: vaultId,
        type: TransactionType.contribute,
        status: TransactionStatus.confirmed,
      },
      relations: ['user', 'assets'],
      order: { created_at: 'ASC' },
    });

    // 4. Calculate totals
    const totalAcquiredAda = acquisitionTransactions.reduce((sum, tx) => sum + (tx.amount || 0), 0);

    // Calculate contributed value from assets
    let totalContributedValueAda = 0;
    const contributionValueByTransaction: Record<string, number> = {};
    const userContributedValueMap: Record<string, number> = {};

    for (const tx of contributionTransactions) {
      const assets = tx.assets || [];
      let txTotalValue = 0;

      for (const asset of assets) {
        const assetValueAda = asset.dex_price
          ? asset.dex_price * asset.quantity
          : asset.floor_price
            ? asset.floor_price * asset.quantity
            : 0;
        txTotalValue += assetValueAda;
      }

      contributionValueByTransaction[tx.id] = txTotalValue;
      totalContributedValueAda += txTotalValue;

      if (tx.user?.id) {
        userContributedValueMap[tx.user.id] = (userContributedValueMap[tx.user.id] || 0) + txTotalValue;
      }
    }

    const vtSupply = (vault.ft_token_supply || 0) * 10 ** (vault.ft_token_decimals || 0);
    const ASSETS_OFFERED_PERCENT = (vault.tokens_for_acquires || 0) * 0.01;
    const LP_PERCENT = (vault.liquidity_pool_contribution || 0) * 0.01;

    // 5. Calculate LP allocation
    const lpResult = this.distributionCalculationService.calculateLpTokens({
      vtSupply,
      totalAcquiredAda,
      totalContributedValueAda,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
    });

    const { lpAdaAmount, lpVtAmount, vtPrice, fdv, adjustedVtLpAmount } = lpResult;

    // 6. Calculate expected claims
    const expectedClaims = new Map<string, { vtAmount: number; lovelaceAmount: number; multiplier?: number }>();
    const expectedClaimsByType = {
      acquirer: [] as any[],
      contributor: [] as any[],
      lp: null as any,
    };

    // Calculate expected acquirer claims
    for (const tx of acquisitionTransactions) {
      if (!tx.user?.id) continue;
      const adaSent = tx.amount || 0;
      if (adaSent <= 0) continue;

      const { vtReceived, multiplier } = this.distributionCalculationService.calculateAcquirerTokens({
        adaSent,
        totalAcquiredValueAda: totalAcquiredAda,
        lpAdaAmount,
        lpVtAmount,
        vtPrice,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      expectedClaimsByType.acquirer.push({
        transactionId: tx.id,
        vtAmount: vtReceived,
        multiplier,
        adaSent,
      });
    }

    // Apply minimum multiplier normalization for acquirers (like in lifecycle service)
    if (expectedClaimsByType.acquirer.length > 0) {
      const minMultiplier = Math.min(...expectedClaimsByType.acquirer.map(c => c.multiplier));
      for (const claim of expectedClaimsByType.acquirer) {
        claim.vtAmount = minMultiplier * claim.adaSent * 1_000_000;
        claim.multiplier = minMultiplier;
        expectedClaims.set(claim.transactionId, {
          vtAmount: claim.vtAmount,
          lovelaceAmount: 0,
          multiplier: claim.multiplier,
        });
      }
    }

    // Calculate expected contributor claims
    for (const tx of contributionTransactions) {
      if (!tx.user?.id) continue;
      const txValueAda = contributionValueByTransaction[tx.id] || 0;
      if (txValueAda <= 0) continue;

      const userTotalValue = userContributedValueMap[tx.user.id] || 0;

      const contributorResult = this.distributionCalculationService.calculateContributorTokens({
        txContributedValue: txValueAda,
        userTotalValue,
        totalAcquiredAda,
        totalTvl: totalContributedValueAda,
        lpAdaAmount,
        lpVtAmount,
        vtSupply,
        ASSETS_OFFERED_PERCENT,
      });

      expectedClaimsByType.contributor.push({
        transactionId: tx.id,
        vtAmount: contributorResult.vtAmount,
        lovelaceAmount: contributorResult.lovelaceAmount,
      });

      expectedClaims.set(tx.id, {
        vtAmount: Math.floor(contributorResult.vtAmount),
        lovelaceAmount: Math.floor(contributorResult.lovelaceAmount),
      });
    }

    // Calculate expected LP claim
    if (lpAdaAmount > 0 && lpVtAmount > 0) {
      expectedClaimsByType.lp = {
        vtAmount: adjustedVtLpAmount,
        lovelaceAmount: Math.floor(lpAdaAmount * 1_000_000),
      };
    }

    // 7. Compare actual vs expected
    const discrepancies: ClaimDiscrepancy[] = [];
    let actualTotalVt = 0;
    let expectedTotalVt = 0;
    let actualTotalAda = 0;
    let expectedTotalAda = 0;
    let maxVtRoundingError = 0;
    let maxAdaRoundingError = 0;

    const claimsByType = {
      acquirer: allClaims.filter(c => c.type === ClaimType.ACQUIRER),
      contributor: allClaims.filter(c => c.type === ClaimType.CONTRIBUTOR),
      lp: allClaims.filter(c => c.type === ClaimType.LP),
    };

    // Check acquirer claims
    for (const claim of claimsByType.acquirer) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;

      if (expected) {
        expectedTotalVt += expected.vtAmount;
        expectedTotalAda += expected.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expected.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          // Allow 1 unit rounding tolerance
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            transactionId: claim.transaction?.id,
            type: ClaimType.ACQUIRER,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expected.vtAmount,
            difference: (Number(claim.amount) || 0) - expected.vtAmount,
            percentageDifference:
              expected.vtAmount > 0 ? (((Number(claim.amount) || 0) - expected.vtAmount) / expected.vtAmount) * 100 : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expected.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount,
            actualMultiplier: Number(claim.multiplier) || null,
            expectedMultiplier: expected.multiplier,
            details: {
              adaSent: claim.transaction?.amount,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          transactionId: claim.transaction?.id,
          type: ClaimType.ACQUIRER,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'No corresponding transaction found for recalculation',
          },
        });
      }
    }

    // Check contributor claims
    for (const claim of claimsByType.contributor) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;

      if (expected) {
        expectedTotalVt += expected.vtAmount;
        expectedTotalAda += expected.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expected.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            transactionId: claim.transaction?.id,
            type: ClaimType.CONTRIBUTOR,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expected.vtAmount,
            difference: (Number(claim.amount) || 0) - expected.vtAmount,
            percentageDifference:
              expected.vtAmount > 0 ? (((Number(claim.amount) || 0) - expected.vtAmount) / expected.vtAmount) * 100 : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expected.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expected.lovelaceAmount,
            details: {
              contributionValue: claim.transaction?.id ? contributionValueByTransaction[claim.transaction.id] : 0,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          transactionId: claim.transaction?.id,
          type: ClaimType.CONTRIBUTOR,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'No corresponding transaction found for recalculation',
          },
        });
      }
    }

    // Check LP claim
    for (const claim of claimsByType.lp) {
      actualTotalVt += Number(claim.amount) || 0;
      actualTotalAda += Number(claim.lovelace_amount) || 0;

      if (expectedClaimsByType.lp) {
        expectedTotalVt += expectedClaimsByType.lp.vtAmount;
        expectedTotalAda += expectedClaimsByType.lp.lovelaceAmount;

        const vtDiff = Math.abs((Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount);
        const adaDiff = Math.abs((Number(claim.lovelace_amount) || 0) - expectedClaimsByType.lp.lovelaceAmount);

        maxVtRoundingError = Math.max(maxVtRoundingError, vtDiff);
        maxAdaRoundingError = Math.max(maxAdaRoundingError, adaDiff);

        if (vtDiff > 1 || adaDiff > 1) {
          discrepancies.push({
            claimId: claim.id,
            userId: claim.user_id,
            type: ClaimType.LP,
            actualAmount: Number(claim.amount) || 0,
            expectedAmount: expectedClaimsByType.lp.vtAmount,
            difference: (Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount,
            percentageDifference:
              expectedClaimsByType.lp.vtAmount > 0
                ? (((Number(claim.amount) || 0) - expectedClaimsByType.lp.vtAmount) /
                    expectedClaimsByType.lp.vtAmount) *
                  100
                : 0,
            actualLovelaceAmount: Number(claim.lovelace_amount) || null,
            expectedLovelaceAmount: expectedClaimsByType.lp.lovelaceAmount,
            lovelaceDifference: (Number(claim.lovelace_amount) || 0) - expectedClaimsByType.lp.lovelaceAmount,
            details: {
              lpPercent: LP_PERCENT * 100,
              fdv,
            },
          });
        }
      } else {
        discrepancies.push({
          claimId: claim.id,
          userId: claim.user_id,
          type: ClaimType.LP,
          actualAmount: Number(claim.amount) || 0,
          expectedAmount: 0,
          difference: Number(claim.amount) || 0,
          percentageDifference: 100,
          details: {
            reason: 'LP claim exists in database but should not exist based on calculations',
          },
        });
      }
    }

    // Build context
    const context: VaultCalculationContext = {
      vaultId: vault.id,
      vaultName: vault.name,
      vaultStatus: vault.vault_status,
      totalAcquiredAda,
      totalContributedValueAda,
      vtSupply,
      assetsOfferedPercent: ASSETS_OFFERED_PERCENT,
      lpPercent: LP_PERCENT,
      lpAdaAmount,
      lpVtAmount,
      vtPrice,
      fdv,
      acquisitionTransactions: acquisitionTransactions.length,
      contributionTransactions: contributionTransactions.length,
    };

    // Build summary
    const summary: ClaimVerificationSummary = {
      totalClaims: allClaims.length,
      validClaims: allClaims.length - discrepancies.length,
      claimsWithDiscrepancies: discrepancies.length,
      acquirerClaims: claimsByType.acquirer.length,
      contributorClaims: claimsByType.contributor.length,
      lpClaims: claimsByType.lp.length,
      actualTotalVtDistributed: actualTotalVt,
      expectedTotalVtDistributed: expectedTotalVt,
      vtDistributionDifference: actualTotalVt - expectedTotalVt,
      actualTotalAdaDistributed: actualTotalAda,
      expectedTotalAdaDistributed: expectedTotalAda,
      adaDistributionDifference: actualTotalAda - expectedTotalAda,
      maxVtRoundingError,
      maxAdaRoundingError,
    };

    // Build formulas explanation
    const formulas = {
      lpCalculation: {
        formula: 'LP = (LP_PERCENT × FDV) / 2  (split equally between ADA and VT)',
        steps: [
          '1. Calculate FDV (Fully Diluted Valuation):',
          '   - If acquirers exist: FDV = totalAcquiredAda / ASSETS_OFFERED_PERCENT',
          '   - If no acquirers: FDV = totalContributedValueAda',
          '2. LP ADA Amount = round((LP_PERCENT × FDV / 2) × 1,000,000) / 1,000,000',
          '3. LP VT Amount = round25((LP_PERCENT × vtSupply) / 2)',
          '4. VT Price = LP ADA Amount / LP VT Amount',
          '5. ADA Pair Multiplier = floor(LP VT Amount / (totalAcquiredAda × 1,000,000))',
          '6. Adjusted VT LP Amount = adaPairMultiplier × totalAcquiredAda × 1,000,000',
        ],
        roundingApplied: [
          'round25() - Rounds to 25 decimal places to prevent floating point errors',
          'Math.round() - Standard rounding for ADA amounts',
          'Math.floor() - Used for multiplier calculation to ensure integer values',
        ],
        intermediateValues: {
          fdv,
          lpAdaAmount,
          lpVtAmount,
          vtPrice,
          adjustedVtLpAmount,
        },
      },
      acquirerCalculation: {
        formula: 'VT = multiplier × adaSent × 1,000,000',
        steps: [
          '1. Calculate percentage of total acquire ADA:',
          '   percentOfTotal = round25(adaSent / totalAcquiredAda)',
          '2. Calculate VT received (before multiplier adjustment):',
          '   vtReceived = round25(percentOfTotal × ASSETS_OFFERED_PERCENT × (vtSupply - lpVtAmount))',
          '3. Calculate multiplier (integer for on-chain):',
          '   multiplier = floor(vtReceived / adaSent / 1,000,000)',
          '4. Adjust VT amount using multiplier:',
          '   finalVT = multiplier × adaSent × 1,000,000',
          '5. Apply minimum multiplier normalization:',
          '   minMultiplier = min(all acquirer multipliers)',
          '   normalizedVT = minMultiplier × adaSent × 1,000,000',
        ],
        roundingApplied: [
          'round25() - Applied twice: for percentage calculation and initial VT calculation',
          'Math.floor() - Used for multiplier to ensure integer value',
          'Multiplier normalization - All acquirers use the minimum multiplier for fairness',
        ],
        example:
          acquisitionTransactions.length > 0 && expectedClaimsByType.acquirer.length > 0
            ? {
                input: {
                  adaSent: acquisitionTransactions[0].amount || 0,
                  totalAcquiredAda,
                  lpVtAmount,
                  vtSupply,
                  ASSETS_OFFERED_PERCENT,
                },
                output: {
                  vtReceived: expectedClaimsByType.acquirer[0].vtAmount,
                  multiplier: expectedClaimsByType.acquirer[0].multiplier,
                },
              }
            : undefined,
      },
      contributorCalculation: {
        formula: 'VT = userTotalVtTokens × proportionOfUserTotal; ADA = userAdaShare × proportionOfUserTotal',
        steps: [
          '1. Calculate user proportion of this transaction:',
          '   proportionOfUserTotal = txContributedValue / userTotalValue',
          '2. Calculate contributor share of total:',
          '   contributorShare = userTotalValue / totalTvl',
          '3. Calculate VT tokens (if ASSETS_OFFERED_PERCENT < 100%):',
          '   userTotalVtTokens = round25((vtSupply - lpVtAmount) × (1 - ASSETS_OFFERED_PERCENT) × contributorShare)',
          '   vtAmount = floor(userTotalVtTokens × proportionOfUserTotal)',
          '4. Calculate ADA distribution:',
          '   adaForContributors = totalAcquiredAda - lpAdaAmount',
          '   userAdaShare = contributorShare × adaForContributors',
          '   adaAmount = floor(userAdaShare × proportionOfUserTotal × 1,000,000) lovelace',
          '5. Edge case: If ASSETS_OFFERED_PERCENT = 100%, vtAmount = 0 (contributors get only ADA)',
        ],
        roundingApplied: [
          'round25() - Applied to userTotalVtTokens calculation',
          'Math.floor() - Applied to final VT amount for this transaction',
          'Math.floor() - Applied to final lovelace amount',
          'Intermediate calculations may compound rounding from multiple transactions',
        ],
        example:
          contributionTransactions.length > 0 && expectedClaimsByType.contributor.length > 0
            ? {
                input: {
                  txContributedValue: contributionValueByTransaction[contributionTransactions[0].id] || 0,
                  userTotalValue: Object.values(userContributedValueMap)[0] || 0,
                  totalTvl: totalContributedValueAda,
                  lpVtAmount,
                  totalAcquiredAda,
                  lpAdaAmount,
                },
                output: {
                  vtAmount: expectedClaimsByType.contributor[0].vtAmount,
                  lovelaceAmount: expectedClaimsByType.contributor[0].lovelaceAmount,
                },
              }
            : undefined,
      },
      roundingMethods: {
        round25: 'Rounds to 25 decimal places: Math.round(value × 10^25) / 10^25',
        mathFloor: 'Always rounds down to nearest integer: Math.floor(value)',
        mathRound: 'Rounds to nearest integer: Math.round(value)',
      },
    };

    this.logger.log(
      `Claims verification complete for vault ${vaultId}: ` +
        `${discrepancies.length} discrepancies found out of ${allClaims.length} claims`
    );

    // Build per-user breakdown
    const userBreakdownMap = new Map<
      string,
      {
        userId: string;
        userAddress?: string;
        totalVtClaimed: number;
        totalAdaClaimed: number;
        contributionTransactions: number;
        acquisitionTransactions: number;
        totalContributed?: number;
        totalAcquired?: number;
        discrepancyCount: number;
        maxVtDiscrepancy: number;
        maxAdaDiscrepancy: number;
        tvlSharePercent?: number;
        expectedVtFromTvlShare?: number;
        claims: Array<{
          claimId: string;
          type: ClaimType;
          actualVt: number;
          expectedVt: number;
          actualAda: number;
          expectedAda: number;
          transactionId?: string;
        }>;
      }
    >();

    // Process all claims to build user breakdowns
    for (const claim of allClaims) {
      const userId = claim.user_id || claim.user?.id;
      if (!userId) continue;

      if (!userBreakdownMap.has(userId)) {
        userBreakdownMap.set(userId, {
          userId,
          userAddress: claim.user?.address,
          totalVtClaimed: 0,
          totalAdaClaimed: 0,
          contributionTransactions: 0,
          acquisitionTransactions: 0,
          totalContributed: 0,
          totalAcquired: 0,
          discrepancyCount: 0,
          maxVtDiscrepancy: 0,
          maxAdaDiscrepancy: 0,
          claims: [],
        });
      }

      const userBreakdown = userBreakdownMap.get(userId);
      const actualVt = Number(claim.amount) || 0;
      const actualAda = Number(claim.lovelace_amount) || 0;

      // Get expected amounts
      const expected = claim.transaction?.id ? expectedClaims.get(claim.transaction.id) : null;
      const expectedVt = claim.type === ClaimType.LP ? expectedClaimsByType.lp?.vtAmount || 0 : expected?.vtAmount || 0;
      const expectedAda =
        claim.type === ClaimType.LP ? expectedClaimsByType.lp?.lovelaceAmount || 0 : expected?.lovelaceAmount || 0;

      // Update totals
      userBreakdown.totalVtClaimed += actualVt;
      userBreakdown.totalAdaClaimed += actualAda;

      // Update transaction counts and amounts
      if (claim.type === ClaimType.CONTRIBUTOR) {
        userBreakdown.contributionTransactions++;
        if (claim.transaction?.id) {
          userBreakdown.totalContributed += contributionValueByTransaction[claim.transaction.id] || 0;
        }
      } else if (claim.type === ClaimType.ACQUIRER) {
        userBreakdown.acquisitionTransactions++;
        userBreakdown.totalAcquired += claim.transaction?.amount || 0;
      }

      // Check for discrepancies
      const vtDiff = Math.abs(actualVt - expectedVt);
      const adaDiff = Math.abs(actualAda - expectedAda);

      if (vtDiff > 1 || adaDiff > 1) {
        userBreakdown.discrepancyCount++;
        userBreakdown.maxVtDiscrepancy = Math.max(userBreakdown.maxVtDiscrepancy, vtDiff);
        userBreakdown.maxAdaDiscrepancy = Math.max(userBreakdown.maxAdaDiscrepancy, adaDiff);
      }

      // Add claim details
      userBreakdown.claims.push({
        claimId: claim.id,
        type: claim.type,
        actualVt,
        expectedVt,
        actualAda,
        expectedAda,
        transactionId: claim.transaction?.id,
      });
    }

    // Calculate TVL share percentage for contributors
    for (const breakdown of userBreakdownMap.values()) {
      if (breakdown.contributionTransactions > 0 && totalContributedValueAda > 0) {
        breakdown.tvlSharePercent = (breakdown.totalContributed / totalContributedValueAda) * 100;

        // Calculate expected VT from simple TVL share (for comparison with actual formula)
        const vtForContributors = (vtSupply - lpVtAmount) * (1 - ASSETS_OFFERED_PERCENT);
        breakdown.expectedVtFromTvlShare = Math.floor(
          (breakdown.totalContributed / totalContributedValueAda) * vtForContributors
        );
      }
    }

    // Convert map to array, sorted by total VT claimed (descending)
    let userBreakdowns = Array.from(userBreakdownMap.values()).sort((a, b) => b.totalVtClaimed - a.totalVtClaimed);

    // Apply filters if provided
    if (query?.userAddress) {
      const searchAddress = query.userAddress.toLowerCase();
      userBreakdowns = userBreakdowns.filter(
        user => user.userAddress && user.userAddress.toLowerCase().includes(searchAddress)
      );
    }

    if (query?.userId) {
      userBreakdowns = userBreakdowns.filter(user => user.userId === query.userId);
    }

    // Filter discrepancies to match filtered users
    let filteredDiscrepancies = discrepancies;
    if (query?.userAddress || query?.userId) {
      const filteredUserIds = new Set(userBreakdowns.map(u => u.userId));
      filteredDiscrepancies = discrepancies.filter(d => filteredUserIds.has(d.userId));
    }

    return {
      success: true,
      message:
        filteredDiscrepancies.length === 0
          ? 'All claims match expected calculations'
          : `Found ${filteredDiscrepancies.length} claim(s) with discrepancies${query?.userAddress || query?.userId ? ' (filtered)' : ''}`,
      context,
      formulas,
      summary,
      discrepancies: filteredDiscrepancies,
      userBreakdowns,
      verifiedAt: new Date(),
    };
  }
}
