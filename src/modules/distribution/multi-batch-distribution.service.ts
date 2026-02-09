import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Claim } from '@/database/claim.entity';
import { Vault } from '@/database/vault.entity';
import { VaultManagingService } from '@/modules/vaults/processing-tx/onchain/vault-managing.service';
import { ClaimStatus, ClaimType } from '@/types/claim.types';
import { SmartContractVaultStatus } from '@/types/vault.types';

interface BatchSplitResult {
  currentBatchMultipliers: Array<[string, string | null, number]>;
  currentBatchAdaDistribution: Array<[string, string, number]>;
  remainingMultipliers: Array<[string, string | null, number]>;
  remainingAdaDistribution: Array<[string, string, number]>;
  batchNumber: number;
  totalBatches: number;
}

/**
 * Multi-Batch Distribution Service
 *
 * Handles splitting multiplier arrays across multiple transactions when
 * the full array would exceed Cardano's 16KB transaction size limit.
 *
 * Uses binary search to find the optimal split point.
 */
@Injectable()
export class MultiBatchDistributionService {
  private readonly logger = new Logger(MultiBatchDistributionService.name);

  // Target 85% of max size to leave room for signatures and other tx data
  private readonly TARGET_SIZE_PERCENT = 85;
  private readonly MAX_TX_SIZE_BYTES = 16384;

  constructor(
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    @InjectRepository(Claim)
    private readonly claimRepository: Repository<Claim>,
    private readonly vaultManagingService: VaultManagingService
  ) {}

  /**
   * Determine if multipliers need to be split across multiple transactions
   * and calculate optimal batching
   */
  async calculateBatchingStrategy(
    vault: Pick<
      Vault,
      'id' | 'asset_vault_name' | 'privacy' | 'contribution_phase_start' | 'contribution_duration' | 'value_method'
    >,
    acquireMultiplier: Array<[string, string | null, number]>,
    adaDistribution: Array<[string, string, number]>,
    adaPairMultiplier: number
  ): Promise<{
    needsBatching: boolean;
    totalBatches: number;
    firstBatchMultipliers: Array<[string, string | null, number]>;
    firstBatchAdaDistribution: Array<[string, string, number]>;
    pendingMultipliers: Array<[string, string | null, number]>;
    pendingAdaDistribution: Array<[string, string, number]>;
  }> {
    // First, try with all multipliers
    try {
      const fullSizeEstimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
        vault,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        acquireMultiplier,
        adaDistribution,
        adaPairMultiplier,
      });

      if (fullSizeEstimate.withinLimit && fullSizeEstimate.percentOfMax <= this.TARGET_SIZE_PERCENT) {
        this.logger.log(
          `Vault ${vault.id}: All ${acquireMultiplier.length} multipliers fit in single transaction ` +
            `(${fullSizeEstimate.percentOfMax}% of max)`
        );
        return {
          needsBatching: false,
          totalBatches: 1,
          firstBatchMultipliers: acquireMultiplier,
          firstBatchAdaDistribution: adaDistribution,
          pendingMultipliers: [],
          pendingAdaDistribution: [],
        };
      }
    } catch (error) {
      this.logger.warn(`Full multiplier array failed size estimation, will need batching: ${error.message}`);
    }

    // Need to split - use binary search to find optimal batch size
    this.logger.log(
      `Vault ${vault.id}: ${acquireMultiplier.length} multipliers too large, starting binary search split`
    );

    const batchResult = await this.binarySearchOptimalBatchSize(
      vault,
      acquireMultiplier,
      adaDistribution,
      adaPairMultiplier
    );

    // Calculate total batches needed
    const totalBatches = this.estimateTotalBatches(acquireMultiplier.length, batchResult.firstBatchMultipliers.length);

    this.logger.log(
      `Vault ${vault.id}: Split into ${totalBatches} batches. ` +
        `First batch: ${batchResult.firstBatchMultipliers.length} multipliers, ` +
        `Remaining: ${batchResult.pendingMultipliers.length} multipliers`
    );

    return {
      needsBatching: true,
      totalBatches,
      ...batchResult,
    };
  }

  /**
   * Binary search to find the maximum number of multipliers that fit in a transaction
   */
  private async binarySearchOptimalBatchSize(
    vault: Pick<
      Vault,
      'id' | 'asset_vault_name' | 'privacy' | 'contribution_phase_start' | 'contribution_duration' | 'value_method'
    >,
    acquireMultiplier: Array<[string, string | null, number]>,
    adaDistribution: Array<[string, string, number]>,
    adaPairMultiplier: number
  ): Promise<{
    firstBatchMultipliers: Array<[string, string | null, number]>;
    firstBatchAdaDistribution: Array<[string, string, number]>;
    pendingMultipliers: Array<[string, string | null, number]>;
    pendingAdaDistribution: Array<[string, string, number]>;
  }> {
    let low = 1;
    let high = acquireMultiplier.length;
    let optimalCount = Math.floor(acquireMultiplier.length / 2); // Start with half as fallback

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);

      // Calculate proportional ADA distribution count
      const adaCount = Math.floor((mid / acquireMultiplier.length) * adaDistribution.length);

      try {
        const estimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
          vault,
          vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
          acquireMultiplier: acquireMultiplier.slice(0, mid),
          adaDistribution: adaDistribution.slice(0, adaCount),
          adaPairMultiplier,
        });

        if (estimate.withinLimit && estimate.percentOfMax <= this.TARGET_SIZE_PERCENT) {
          // This size fits, try larger
          optimalCount = mid;
          low = mid + 1;
        } else {
          // Too large, try smaller
          high = mid - 1;
        }
      } catch (error) {
        // Transaction build failed, assume too large
        high = mid - 1;
      }
    }

    // Ensure we have at least some entries (minimum 10 or available)
    optimalCount = Math.max(optimalCount, Math.min(10, acquireMultiplier.length));

    const adaOptimalCount = Math.floor((optimalCount / acquireMultiplier.length) * adaDistribution.length);

    return {
      firstBatchMultipliers: acquireMultiplier.slice(0, optimalCount),
      firstBatchAdaDistribution: adaDistribution.slice(0, adaOptimalCount),
      pendingMultipliers: acquireMultiplier.slice(optimalCount),
      pendingAdaDistribution: adaDistribution.slice(adaOptimalCount),
    };
  }

  /**
   * Estimate total number of batches needed
   */
  private estimateTotalBatches(totalCount: number, firstBatchCount: number): number {
    if (firstBatchCount >= totalCount) return 1;
    const remainingCount = totalCount - firstBatchCount;
    // Assume subsequent batches can fit similar amounts
    return 1 + Math.ceil(remainingCount / firstBatchCount);
  }

  /**
   * Assign batch numbers to claims based on which multipliers are in the current batch
   */
  async assignClaimsToBatch(
    vaultId: string,
    batchMultipliers: Array<[string, string | null, number]>,
    batchNumber: number
  ): Promise<number> {
    // Build a set of (policyId, assetName) pairs from the batch multipliers
    const batchAssetKeys = new Set<string>();

    for (const [policyId, assetName] of batchMultipliers) {
      if (assetName === '' || assetName === null) {
        // Policy-level multiplier - need to find all assets with this policy
        batchAssetKeys.add(`policy:${policyId}`);
      } else {
        batchAssetKeys.add(`${policyId}:${assetName}`);
      }
    }

    // Find claims that match these multipliers
    const claims = await this.claimRepository
      .createQueryBuilder('claim')
      .innerJoin('claim.transaction', 'tx')
      .innerJoin('tx.assets', 'asset')
      .where('claim.vault_id = :vaultId', { vaultId })
      .andWhere('claim.type IN (:...types)', {
        types: [ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER],
      })
      .andWhere('claim.distribution_batch IS NULL')
      .select(['claim.id', 'asset.policy_id', 'asset.asset_id'])
      .getMany();

    // Determine which claims should be in this batch
    const claimIdsForBatch: string[] = [];

    // For policy-level multipliers, we need to check if any asset in the claim matches
    const policyLevelKeys = [...batchAssetKeys].filter(k => k.startsWith('policy:')).map(k => k.replace('policy:', ''));

    for (const claim of claims) {
      const assets = claim.transaction?.assets || [];
      let matchesBatch = false;

      for (const asset of assets) {
        const assetKey = `${asset.policy_id}:${asset.asset_id}`;

        // Check exact match
        if (batchAssetKeys.has(assetKey)) {
          matchesBatch = true;
          break;
        }

        // Check policy-level match
        if (policyLevelKeys.includes(asset.policy_id)) {
          matchesBatch = true;
          break;
        }
      }

      if (matchesBatch) {
        claimIdsForBatch.push(claim.id);
      }
    }

    if (claimIdsForBatch.length > 0) {
      await this.claimRepository.update({ id: In(claimIdsForBatch) }, { distribution_batch: batchNumber });

      this.logger.log(`Vault ${vaultId}: Assigned ${claimIdsForBatch.length} claims to batch ${batchNumber}`);
    }

    return claimIdsForBatch.length;
  }

  /**
   * Check if all claims in current batch are completed
   */
  async isBatchComplete(vaultId: string, batchNumber: number): Promise<boolean> {
    const pendingCount = await this.claimRepository.count({
      where: {
        vault_id: vaultId,
        distribution_batch: batchNumber,
        status: In([ClaimStatus.PENDING, ClaimStatus.AVAILABLE, ClaimStatus.FAILED]),
      },
    });

    return pendingCount === 0;
  }

  /**
   * Get the next batch of multipliers to process
   */
  async getNextBatch(
    vault: Pick<
      Vault,
      | 'id'
      | 'asset_vault_name'
      | 'privacy'
      | 'contribution_phase_start'
      | 'contribution_duration'
      | 'value_method'
      | 'pending_multipliers'
      | 'pending_ada_distribution'
      | 'current_distribution_batch'
      | 'total_distribution_batches'
      | 'ada_pair_multiplier'
    >
  ): Promise<BatchSplitResult | null> {
    if (!vault.pending_multipliers || vault.pending_multipliers.length === 0) {
      return null; // No more batches
    }

    const nextBatchNumber = (vault.current_distribution_batch || 0) + 1;

    // Try to fit all remaining in one transaction first
    try {
      const fullEstimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
        vault,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
        acquireMultiplier: vault.pending_multipliers,
        adaDistribution: vault.pending_ada_distribution || [],
        adaPairMultiplier: vault.ada_pair_multiplier || 0,
      });

      if (fullEstimate.withinLimit && fullEstimate.percentOfMax <= this.TARGET_SIZE_PERCENT) {
        // All remaining fit in one transaction
        return {
          currentBatchMultipliers: vault.pending_multipliers,
          currentBatchAdaDistribution: vault.pending_ada_distribution || [],
          remainingMultipliers: [],
          remainingAdaDistribution: [],
          batchNumber: nextBatchNumber,
          totalBatches: vault.total_distribution_batches || nextBatchNumber,
        };
      }
    } catch {
      // Need to split again
    }

    // Binary search for this batch
    const batchResult = await this.binarySearchOptimalBatchSize(
      vault,
      vault.pending_multipliers,
      vault.pending_ada_distribution || [],
      vault.ada_pair_multiplier || 0
    );

    return {
      currentBatchMultipliers: batchResult.firstBatchMultipliers,
      currentBatchAdaDistribution: batchResult.firstBatchAdaDistribution,
      remainingMultipliers: batchResult.pendingMultipliers,
      remainingAdaDistribution: batchResult.pendingAdaDistribution,
      batchNumber: nextBatchNumber,
      totalBatches: vault.total_distribution_batches || nextBatchNumber,
    };
  }

  /**
   * Update vault with batch progress
   */
  async updateVaultBatchProgress(
    vaultId: string,
    updates: {
      currentBatch?: number;
      totalBatches?: number;
      pendingMultipliers?: Array<[string, string | null, number]>;
      pendingAdaDistribution?: Array<[string, string, number]>;
      acquireMultiplier?: Array<[string, string | null, number]>;
      adaDistribution?: Array<[string, string, number]>;
    }
  ): Promise<void> {
    const updateData: Partial<Vault> = {};

    if (updates.currentBatch !== undefined) {
      updateData.current_distribution_batch = updates.currentBatch;
    }
    if (updates.totalBatches !== undefined) {
      updateData.total_distribution_batches = updates.totalBatches;
    }
    if (updates.pendingMultipliers !== undefined) {
      updateData.pending_multipliers = updates.pendingMultipliers.length > 0 ? updates.pendingMultipliers : null;
    }
    if (updates.pendingAdaDistribution !== undefined) {
      updateData.pending_ada_distribution =
        updates.pendingAdaDistribution.length > 0 ? updates.pendingAdaDistribution : null;
    }
    if (updates.acquireMultiplier !== undefined) {
      updateData.acquire_multiplier = updates.acquireMultiplier;
    }
    if (updates.adaDistribution !== undefined) {
      updateData.ada_distribution = updates.adaDistribution;
    }

    await this.vaultRepository.update({ id: vaultId }, updateData);
  }

  /**
   * Check if vault has completed all distribution batches
   */
  async isAllBatchesComplete(vaultId: string): Promise<boolean> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'pending_multipliers',
        'pending_ada_distribution',
        'current_distribution_batch',
        'total_distribution_batches',
      ],
    });

    if (!vault) return false;

    // Check if no pending multipliers remain
    const hasPending = vault.pending_multipliers && vault.pending_multipliers.length > 0;
    if (hasPending) return false;

    // Check if current batch equals total batches
    if (vault.total_distribution_batches && vault.current_distribution_batch) {
      return vault.current_distribution_batch >= vault.total_distribution_batches;
    }

    return true;
  }

  /**
   * Get claims for a specific batch
   */
  async getClaimsForBatch(
    vaultId: string,
    batchNumber: number,
    types: ClaimType[] = [ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]
  ): Promise<Claim[]> {
    return this.claimRepository.find({
      where: {
        vault_id: vaultId,
        distribution_batch: batchNumber,
        type: In(types),
      },
      relations: ['transaction', 'transaction.assets', 'user'],
    });
  }
}
