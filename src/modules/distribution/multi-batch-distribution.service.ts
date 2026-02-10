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
   * Group multipliers by contribution transaction to ensure all assets from
   * the same transaction stay together in a batch.
   *
   * Returns an array of transaction groups, where each group contains
   * the indices of multipliers belonging to that transaction.
   */
  private async groupMultipliersByTransaction(
    vaultId: string,
    acquireMultiplier: Array<[string, string | null, number]>
  ): Promise<{
    transactionGroups: Array<{
      transactionId: string | null;
      multiplierIndices: number[];
    }>;
    multiplierToGroupIndex: number[];
  }> {
    // Fetch claims with their transaction assets
    const claims = await this.claimRepository.find({
      where: {
        vault_id: vaultId,
        type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
      },
      relations: ['transaction', 'transaction.assets'],
      order: { created_at: 'ASC' },
    });

    // Build a map from (policyId:assetName) to transaction ID
    const assetToTransaction = new Map<string, string>();
    const policyToTransaction = new Map<string, string>(); // For policy-level multipliers

    for (const claim of claims) {
      if (!claim.transaction?.assets) continue;
      const txId = claim.transaction.id;

      for (const asset of claim.transaction.assets) {
        const key = `${asset.policy_id}:${asset.asset_id}`;
        assetToTransaction.set(key, txId);
        // Also track policy-level for fallback
        if (!policyToTransaction.has(asset.policy_id)) {
          policyToTransaction.set(asset.policy_id, txId);
        }
      }
    }

    // Group multipliers by their transaction
    const multiplierToGroupIndex: number[] = new Array(acquireMultiplier.length);
    const transactionToGroup = new Map<string, number>();
    const transactionGroups: Array<{
      transactionId: string | null;
      multiplierIndices: number[];
    }> = [];

    for (let i = 0; i < acquireMultiplier.length; i++) {
      const [policyId, assetName] = acquireMultiplier[i];

      // Find transaction ID for this multiplier
      let txId: string | null = null;
      if (assetName && assetName !== '') {
        txId = assetToTransaction.get(`${policyId}:${assetName}`) || null;
      }
      if (!txId) {
        // Policy-level multiplier - use first transaction with this policy
        txId = policyToTransaction.get(policyId) || null;
      }

      // Assign to existing group or create new one
      const groupKey = txId || `unknown_${i}`; // Unique key for orphaned multipliers
      let groupIndex = transactionToGroup.get(groupKey);

      if (groupIndex === undefined) {
        groupIndex = transactionGroups.length;
        transactionToGroup.set(groupKey, groupIndex);
        transactionGroups.push({
          transactionId: txId,
          multiplierIndices: [],
        });
      }

      transactionGroups[groupIndex].multiplierIndices.push(i);
      multiplierToGroupIndex[i] = groupIndex;
    }

    this.logger.debug(
      `Vault ${vaultId}: Grouped ${acquireMultiplier.length} multipliers into ${transactionGroups.length} transaction groups`
    );

    return { transactionGroups, multiplierToGroupIndex };
  }

  /**
   * Binary search to find the maximum number of multipliers that fit in a transaction.
   * Respects transaction boundaries to ensure all assets from the same contribution
   * transaction stay together in the same batch.
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
    // Group multipliers by transaction to respect boundaries
    const { transactionGroups } = await this.groupMultipliersByTransaction(vault.id, acquireMultiplier);

    // If only one group, we can't split further
    if (transactionGroups.length <= 1) {
      this.logger.warn(
        `Vault ${vault.id}: All ${acquireMultiplier.length} multipliers belong to one transaction group - cannot split`
      );
      return {
        firstBatchMultipliers: acquireMultiplier,
        firstBatchAdaDistribution: adaDistribution,
        pendingMultipliers: [],
        pendingAdaDistribution: [],
      };
    }

    // Binary search on number of transaction groups that fit
    let low = 1;
    let high = transactionGroups.length;
    let optimalGroupCount = Math.floor(transactionGroups.length / 2); // Start with half as fallback

    while (low <= high) {
      const midGroupCount = Math.floor((low + high) / 2);

      // Get multiplier indices for first N groups
      const batchMultiplierIndices: number[] = [];
      for (let g = 0; g < midGroupCount; g++) {
        batchMultiplierIndices.push(...transactionGroups[g].multiplierIndices);
      }

      // Sort indices to maintain original order
      batchMultiplierIndices.sort((a, b) => a - b);

      // Get the actual multipliers for this batch
      const batchMultipliers = batchMultiplierIndices.map(i => acquireMultiplier[i]);

      // Calculate proportional ADA distribution count
      const adaCount = Math.floor((batchMultipliers.length / acquireMultiplier.length) * adaDistribution.length);
      const batchAdaDistribution = adaDistribution.slice(0, adaCount);

      try {
        const estimate = await this.vaultManagingService.estimateUpdateVaultTxSize({
          vault,
          vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
          acquireMultiplier: batchMultipliers,
          adaDistribution: batchAdaDistribution,
          adaPairMultiplier,
        });

        if (estimate.withinLimit && estimate.percentOfMax <= this.TARGET_SIZE_PERCENT) {
          // This size fits, try more groups
          optimalGroupCount = midGroupCount;
          low = midGroupCount + 1;
        } else {
          // Too large, try fewer groups
          high = midGroupCount - 1;
        }
      } catch (error) {
        // Transaction build failed, assume too large
        high = midGroupCount - 1;
      }
    }

    // Ensure we have at least 1 group
    optimalGroupCount = Math.max(optimalGroupCount, 1);

    // Build the final batch and remaining arrays using group boundaries
    const firstBatchIndices: number[] = [];
    const pendingIndices: number[] = [];

    for (let g = 0; g < transactionGroups.length; g++) {
      if (g < optimalGroupCount) {
        firstBatchIndices.push(...transactionGroups[g].multiplierIndices);
      } else {
        pendingIndices.push(...transactionGroups[g].multiplierIndices);
      }
    }

    // Sort to maintain original order
    firstBatchIndices.sort((a, b) => a - b);
    pendingIndices.sort((a, b) => a - b);

    const firstBatchMultipliers = firstBatchIndices.map(i => acquireMultiplier[i]);
    const pendingMultipliers = pendingIndices.map(i => acquireMultiplier[i]);

    // Calculate ADA distribution split proportionally
    const adaFirstCount = Math.floor(
      (firstBatchMultipliers.length / acquireMultiplier.length) * adaDistribution.length
    );

    this.logger.log(
      `Vault ${vault.id}: Batch split at transaction boundary - ` +
        `${optimalGroupCount}/${transactionGroups.length} transaction groups, ` +
        `${firstBatchMultipliers.length}/${acquireMultiplier.length} multipliers`
    );

    return {
      firstBatchMultipliers,
      firstBatchAdaDistribution: adaDistribution.slice(0, adaFirstCount),
      pendingMultipliers,
      pendingAdaDistribution: adaDistribution.slice(adaFirstCount),
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
   * Assign batch numbers to claims based on which multipliers are in the current batch.
   * Claims are assigned to the batch containing their assets' multipliers.
   */
  async assignClaimsToBatch(
    vaultId: string,
    batchMultipliers: Array<[string, string | null, number]>,
    batchNumber: number
  ): Promise<number> {
    // Build a set of (policyId, assetName) pairs from the batch multipliers
    const batchAssetKeys = new Set<string>();
    const policyLevelKeys = new Set<string>();

    for (const [policyId, assetName] of batchMultipliers) {
      if (assetName === '' || assetName === null) {
        // Policy-level multiplier - will match all assets with this policy
        policyLevelKeys.add(policyId);
      } else {
        batchAssetKeys.add(`${policyId}:${assetName}`);
      }
    }

    this.logger.debug(
      `Vault ${vaultId}: Assigning claims to batch ${batchNumber}. ` +
        `Asset keys: ${batchAssetKeys.size}, Policy-level keys: ${policyLevelKeys.size}`
    );

    // Find claims with properly loaded relations
    // Need to use leftJoinAndSelect to actually populate the relations
    const claims = await this.claimRepository.find({
      where: {
        vault_id: vaultId,
        type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
        distribution_batch: null as unknown as number, // TypeORM quirk for IS NULL
      },
      relations: ['transaction', 'transaction.assets'],
    });

    this.logger.debug(`Vault ${vaultId}: Found ${claims.length} claims without batch assignment`);

    // Determine which claims should be in this batch
    const claimIdsForBatch: string[] = [];

    for (const claim of claims) {
      const assets = claim.transaction?.assets || [];
      let matchesBatch = false;

      for (const asset of assets) {
        const assetKey = `${asset.policy_id}:${asset.asset_id}`;

        // Check exact asset match
        if (batchAssetKeys.has(assetKey)) {
          matchesBatch = true;
          break;
        }

        // Check policy-level match
        if (policyLevelKeys.has(asset.policy_id)) {
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
   * Check if all claims in current batch are completed.
   * Returns false if no claims have been assigned to this batch yet.
   */
  async isBatchComplete(vaultId: string, batchNumber: number): Promise<boolean> {
    // First check if any claims are assigned to this batch
    const totalBatchClaims = await this.claimRepository.count({
      where: {
        vault_id: vaultId,
        distribution_batch: batchNumber,
      },
    });

    // If no claims assigned to this batch, it's NOT complete (we need assignment first)
    if (totalBatchClaims === 0) {
      this.logger.debug(`Vault ${vaultId}: Batch ${batchNumber} has no claims assigned - not complete`);
      return false;
    }

    // Check for pending/available/failed claims
    const pendingCount = await this.claimRepository.count({
      where: {
        vault_id: vaultId,
        distribution_batch: batchNumber,
        status: In([ClaimStatus.PENDING, ClaimStatus.AVAILABLE, ClaimStatus.FAILED]),
      },
    });

    const isComplete = pendingCount === 0;
    this.logger.debug(
      `Vault ${vaultId}: Batch ${batchNumber} status - ` +
        `total: ${totalBatchClaims}, pending: ${pendingCount}, complete: ${isComplete}`
    );

    return isComplete;
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

  /**
   * Check if a claim can be processed (its multipliers are on-chain)
   * Returns true if the claim's batch is on-chain, false otherwise
   */
  async canClaimBeProcessed(
    vaultId: string,
    claimId: string
  ): Promise<{
    canProcess: boolean;
    reason: string;
    claimBatch: number | null;
    currentBatch: number;
    totalBatches: number | null;
  }> {
    const claim = await this.claimRepository.findOne({
      where: { id: claimId, vault_id: vaultId },
      select: ['id', 'distribution_batch', 'vault_id'],
    });

    if (!claim) {
      return {
        canProcess: false,
        reason: 'Claim not found',
        claimBatch: null,
        currentBatch: 0,
        totalBatches: null,
      };
    }

    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'current_distribution_batch', 'total_distribution_batches'],
    });

    if (!vault) {
      return {
        canProcess: false,
        reason: 'Vault not found',
        claimBatch: claim.distribution_batch,
        currentBatch: 0,
        totalBatches: null,
      };
    }

    const currentBatch = vault.current_distribution_batch || 1;
    const claimBatch = claim.distribution_batch || 1;

    if (claimBatch > currentBatch) {
      return {
        canProcess: false,
        reason: `Claim is in batch ${claimBatch}, but only batches 1-${currentBatch} are on-chain`,
        claimBatch,
        currentBatch,
        totalBatches: vault.total_distribution_batches,
      };
    }

    return {
      canProcess: true,
      reason: 'Claim multipliers are on-chain',
      claimBatch,
      currentBatch,
      totalBatches: vault.total_distribution_batches,
    };
  }

  /**
   * RECOVERY METHOD: Recalculate batch assignments using transaction-boundary-aware logic.
   * Use this when a vault had incorrect batch splitting and needs re-batching.
   *
   * This will:
   * 1. Group ALL multipliers by their contribution transaction
   * 2. Determine which multipliers are already on-chain (batch 1)
   * 3. Re-calculate remaining batches respecting transaction boundaries
   * 4. Re-assign claims to correct batches
   * 5. Update pending_multipliers
   *
   * @param vaultId - The vault ID to recover
   * @param dryRun - If true, only simulate and return what would change
   */
  async recoverBatchAssignments(
    vaultId: string,
    dryRun = true
  ): Promise<{
    success: boolean;
    message: string;
    currentState: {
      onChainMultipliers: number;
      pendingMultipliers: number;
      currentBatch: number;
      totalBatches: number;
    };
    transactionGroups: Array<{
      transactionId: string | null;
      multiplierCount: number;
      claimIds: string[];
      currentBatch: number | null;
      recommendedBatch: number;
    }>;
    proposedChanges: {
      claimsToUpdate: Array<{
        claimId: string;
        currentBatch: number | null;
        newBatch: number;
        transactionId: string | null;
      }>;
      newPendingMultipliers: number;
      newTotalBatches: number;
    };
    dryRun: boolean;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'asset_vault_name',
        'privacy',
        'contribution_phase_start',
        'contribution_duration',
        'value_method',
        'acquire_multiplier',
        'pending_multipliers',
        'ada_distribution',
        'pending_ada_distribution',
        'ada_pair_multiplier',
        'current_distribution_batch',
        'total_distribution_batches',
      ],
    });

    if (!vault) {
      return {
        success: false,
        message: `Vault ${vaultId} not found`,
        currentState: { onChainMultiplizers: 0, pendingMultipliers: 0, currentBatch: 0, totalBatches: 0 } as any,
        transactionGroups: [],
        proposedChanges: { claimsToUpdate: [], newPendingMultipliers: 0, newTotalBatches: 0 },
        dryRun,
      };
    }

    const onChainMultipliers = vault.acquire_multiplier || [];
    const pendingMultipliers = vault.pending_multipliers || [];
    const allMultipliers = [...onChainMultipliers, ...pendingMultipliers];

    // Get transaction groupings
    const { transactionGroups } = await this.groupMultipliersByTransaction(vaultId, allMultipliers);

    // Fetch all claims with their current batch assignments
    const claims = await this.claimRepository.find({
      where: {
        vault_id: vaultId,
        type: In([ClaimType.CONTRIBUTOR, ClaimType.ACQUIRER]),
      },
      relations: ['transaction', 'transaction.assets'],
    });

    // Build claim lookup by transaction ID
    const claimsByTransaction = new Map<string, Claim[]>();
    for (const claim of claims) {
      if (claim.transaction?.id) {
        const existing = claimsByTransaction.get(claim.transaction.id) || [];
        existing.push(claim);
        claimsByTransaction.set(claim.transaction.id, existing);
      }
    }

    // Calculate which groups fit in batch 1 (already on-chain)
    const onChainCount = onChainMultipliers.length;
    let cumulativeCount = 0;
    let batch1GroupCount = 0;

    for (const group of transactionGroups) {
      const groupSize = group.multiplierIndices.length;
      if (cumulativeCount + groupSize <= onChainCount) {
        cumulativeCount += groupSize;
        batch1GroupCount++;
      } else {
        break;
      }
    }

    // Determine batch assignments by transaction group
    const transactionGroupResults: Array<{
      transactionId: string | null;
      multiplierCount: number;
      claimIds: string[];
      currentBatch: number | null;
      recommendedBatch: number;
    }> = [];

    const claimsToUpdate: Array<{
      claimId: string;
      currentBatch: number | null;
      newBatch: number;
      transactionId: string | null;
    }> = [];

    let currentGroupBatch = 1;
    let currentBatchSize = 0;
    const targetBatchSize = Math.ceil(allMultipliers.length / (vault.total_distribution_batches || 2));

    for (let i = 0; i < transactionGroups.length; i++) {
      const group = transactionGroups[i];
      const groupSize = group.multiplierIndices.length;

      // Check if we should start a new batch
      if (
        currentBatchSize + groupSize > targetBatchSize &&
        currentBatchSize > 0 &&
        currentGroupBatch < (vault.total_distribution_batches || 2)
      ) {
        currentGroupBatch++;
        currentBatchSize = 0;
      }

      const recommendedBatch = i < batch1GroupCount ? 1 : currentGroupBatch;
      currentBatchSize += groupSize;

      // Get claims for this transaction
      const txClaims = group.transactionId ? claimsByTransaction.get(group.transactionId) || [] : [];

      transactionGroupResults.push({
        transactionId: group.transactionId,
        multiplierCount: groupSize,
        claimIds: txClaims.map(c => c.id),
        currentBatch: txClaims[0]?.distribution_batch || null,
        recommendedBatch,
      });

      // Check if claims need updating
      for (const claim of txClaims) {
        if (claim.distribution_batch !== recommendedBatch) {
          claimsToUpdate.push({
            claimId: claim.id,
            currentBatch: claim.distribution_batch || null,
            newBatch: recommendedBatch,
            transactionId: group.transactionId,
          });
        }
      }
    }

    // Calculate new pending multipliers (everything after batch 1)
    const batch1Multipliers: Array<[string, string | null, number]> = [];
    const newPendingMultipliers: Array<[string, string | null, number]> = [];

    for (let i = 0; i < transactionGroups.length; i++) {
      const group = transactionGroups[i];
      const multipliers = group.multiplierIndices.map(idx => allMultipliers[idx]);

      if (i < batch1GroupCount) {
        batch1Multipliers.push(...multipliers);
      } else {
        newPendingMultipliers.push(...multipliers);
      }
    }

    const result = {
      success: true,
      message: dryRun
        ? `Dry run complete. ${claimsToUpdate.length} claims would be updated.`
        : `Recovery complete. ${claimsToUpdate.length} claims updated.`,
      currentState: {
        onChainMultipliers: onChainMultipliers.length,
        pendingMultipliers: pendingMultipliers.length,
        currentBatch: vault.current_distribution_batch || 1,
        totalBatches: vault.total_distribution_batches || 1,
      },
      transactionGroups: transactionGroupResults,
      proposedChanges: {
        claimsToUpdate,
        newPendingMultipliers: newPendingMultipliers.length,
        newTotalBatches: Math.max(
          1,
          Math.ceil(transactionGroups.length / batch1GroupCount) || vault.total_distribution_batches || 2
        ),
      },
      dryRun,
    };

    // If not dry run, apply changes
    if (!dryRun && claimsToUpdate.length > 0) {
      for (const update of claimsToUpdate) {
        await this.claimRepository.update({ id: update.claimId }, { distribution_batch: update.newBatch });
      }

      // Update vault pending multipliers
      await this.vaultRepository.update(
        { id: vaultId },
        {
          pending_multipliers: newPendingMultipliers,
          acquire_multiplier: batch1Multipliers,
        }
      );

      this.logger.log(`Recovery applied for vault ${vaultId}: ${claimsToUpdate.length} claims updated`);
    }

    return result;
  }

  /**
   * Force submit the next batch of multipliers regardless of claim completion status.
   * Use this to get all multipliers on-chain so split claims can be processed.
   */
  async forceSubmitNextBatch(vaultId: string): Promise<{
    success: boolean;
    message: string;
    batchNumber?: number;
    multipliersSubmitted?: number;
    txHash?: string;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
    });

    if (!vault) {
      return { success: false, message: `Vault ${vaultId} not found` };
    }

    const pendingMultipliers = vault.pending_multipliers || [];
    const pendingAdaDistribution = vault.pending_ada_distribution || [];

    if (pendingMultipliers.length === 0) {
      return { success: false, message: 'No pending multipliers to submit' };
    }

    const currentBatch = vault.current_distribution_batch || 1;
    const nextBatch = currentBatch + 1;

    // Get next batch using the transaction-boundary-aware logic
    const batchResult = await this.binarySearchOptimalBatchSize(
      vault,
      pendingMultipliers,
      pendingAdaDistribution,
      vault.ada_pair_multiplier || 0
    );

    // Submit the transaction
    try {
      const response = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        acquireMultiplier: batchResult.firstBatchMultipliers,
        adaDistribution: batchResult.firstBatchAdaDistribution,
        adaPairMultiplier: vault.ada_pair_multiplier || 0,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      if (!response.txHash) {
        return { success: false, message: 'Transaction submission failed' };
      }

      // Update vault
      await this.updateVaultBatchProgress(vaultId, {
        currentBatch: nextBatch,
        pendingMultipliers: batchResult.pendingMultipliers,
        pendingAdaDistribution: batchResult.pendingAdaDistribution,
        acquireMultiplier: [...(vault.acquire_multiplier || []), ...batchResult.firstBatchMultipliers],
        adaDistribution: [...(vault.ada_distribution || []), ...batchResult.firstBatchAdaDistribution],
      });

      // Assign claims to this batch
      await this.assignClaimsToBatch(vaultId, batchResult.firstBatchMultipliers, nextBatch);

      this.logger.log(
        `Force submitted batch ${nextBatch} for vault ${vaultId}: ${batchResult.firstBatchMultipliers.length} multipliers`
      );

      return {
        success: true,
        message: `Batch ${nextBatch} submitted successfully`,
        batchNumber: nextBatch,
        multipliersSubmitted: batchResult.firstBatchMultipliers.length,
        txHash: response.txHash,
      };
    } catch (error) {
      this.logger.error(`Failed to force submit batch for vault ${vaultId}:`, error);
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * MANUAL METHOD: Get required multipliers for specific claim IDs
   * Use this to determine what multipliers need to be on-chain for claims to process
   *
   * @param vaultId - The vault ID
   * @param claimIds - Array of claim IDs to check
   * @returns Information about required multipliers and current status
   */
  async getRequiredMultipliersForClaims(
    vaultId: string,
    claimIds: string[]
  ): Promise<{
    vaultId: string;
    currentOnChainMultipliers: number;
    pendingMultipliers: number;
    claims: Array<{
      claimId: string;
      claimBatch: number | null;
      status: string;
      canProcess: boolean;
      transactionId: string;
      contributedAssets: Array<{
        policyId: string;
        assetName: string;
        assetId: string;
        quantity: number;
        multiplierOnChain: boolean;
        multiplierValue: number | null;
      }>;
    }>;
    requiredMultipliers: Array<[string, string | null, number]>;
    recommendation: string;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'acquire_multiplier',
        'pending_multipliers',
        'current_distribution_batch',
        'total_distribution_batches',
        'manual_distribution_mode',
      ],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    const claims = await this.claimRepository.find({
      where: { id: In(claimIds), vault_id: vaultId },
      relations: ['transaction', 'transaction.assets', 'user'],
    });

    if (claims.length === 0) {
      throw new Error(`No claims found for IDs: ${claimIds.join(', ')}`);
    }

    const onChainMultipliers = vault.acquire_multiplier || [];
    const onChainMultiplierMap = new Map<string, number>();
    for (const [policyId, assetName, mult] of onChainMultipliers) {
      const key = assetName ? `${policyId}:${assetName}` : policyId;
      onChainMultiplierMap.set(key, mult);
    }

    const requiredMultipliers = new Map<string, [string, string | null, number]>();
    const claimDetails = [];

    for (const claim of claims) {
      const contributedAssets = claim.transaction?.assets || [];
      const assetDetails = [];

      for (const asset of contributedAssets) {
        const key = asset.asset_id ? `${asset.policy_id}:${asset.asset_id}` : asset.policy_id;
        const policyKey = asset.policy_id;

        let multiplierValue: number | null = null;
        let multiplierOnChain = false;

        // Check if specific asset multiplier exists
        if (asset.asset_id && onChainMultiplierMap.has(key)) {
          multiplierValue = onChainMultiplierMap.get(key);
          multiplierOnChain = true;
        }
        // Check if policy-level multiplier exists
        else if (onChainMultiplierMap.has(policyKey)) {
          multiplierValue = onChainMultiplierMap.get(policyKey);
          multiplierOnChain = true;
        }

        assetDetails.push({
          policyId: asset.policy_id,
          assetName: asset.name,
          assetId: asset.asset_id || '',
          quantity: Number(asset.quantity),
          multiplierOnChain,
          multiplierValue,
        });

        // If not on-chain, add to required list
        if (!multiplierOnChain && multiplierValue === null) {
          // Check if multiplier exists in pending_multipliers or needs to be calculated
          const pendingMult = (vault.pending_multipliers || []).find(
            ([p, a]) => p === asset.policy_id && (a === asset.asset_id || (!a && !asset.asset_id))
          );

          if (pendingMult) {
            requiredMultipliers.set(key, pendingMult);
          } else {
            // Calculate expected multiplier (you'll need to implement this based on your logic)
            // For now, mark as missing
            this.logger.warn(
              `Missing multiplier for ${asset.policy_id}:${asset.asset_id || 'ADA'} in claim ${claim.id}`
            );
          }
        }
      }

      const canProcess = assetDetails.every(a => a.multiplierOnChain);
      claimDetails.push({
        claimId: claim.id,
        claimBatch: claim.distribution_batch,
        status: claim.status,
        canProcess,
        transactionId: claim.transaction?.id,
        contributedAssets: assetDetails,
      });
    }

    const requiredMultipliersArray = Array.from(requiredMultipliers.values());
    const allClaimsCanProcess = claimDetails.every(c => c.canProcess);

    let recommendation = '';
    if (allClaimsCanProcess) {
      recommendation = '✅ All claims can be processed with current on-chain multipliers.';
    } else {
      const missingCount = claimDetails.filter(c => !c.canProcess).length;
      recommendation =
        `⚠️ ${missingCount} claim(s) cannot be processed. ` +
        `${requiredMultipliersArray.length} multiplier(s) need to be added on-chain. ` +
        `Use manuallyUpdateVaultMultipliers() to add them.`;
    }

    return {
      vaultId,
      currentOnChainMultipliers: onChainMultipliers.length,
      pendingMultipliers: (vault.pending_multipliers || []).length,
      claims: claimDetails,
      requiredMultipliers: requiredMultipliersArray,
      recommendation,
    };
  }

  /**
   * MANUAL METHOD: Manually update vault with additional multipliers
   * Use this when automated batch progression is disabled (manual_distribution_mode = true)
   *
   * @param vaultId - The vault ID
   * @param additionalMultipliers - Multipliers to add to the vault
   * @param additionalAdaDistribution - ADA distribution to add
   * @param updateDescription - Optional description of why this manual update is needed
   * @returns Transaction hash and updated vault state
   */
  async manuallyUpdateVaultMultipliers(
    vaultId: string,
    additionalMultipliers: Array<[string, string | null, number]>,
    additionalAdaDistribution: Array<[string, string, number]> = [],
    updateDescription?: string
  ): Promise<{
    success: boolean;
    txHash?: string;
    message: string;
    newMultiplierCount: number;
    newOnChainMultipliers: Array<[string, string | null, number]>;
  }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: [
        'id',
        'asset_vault_name',
        'privacy',
        'contribution_phase_start',
        'contribution_duration',
        'value_method',
        'acquire_multiplier',
        'ada_distribution',
        'ada_pair_multiplier',
        'pending_multipliers',
        'pending_ada_distribution',
        'manual_distribution_mode',
      ],
    });

    if (!vault) {
      throw new Error(`Vault ${vaultId} not found`);
    }

    if (!vault.manual_distribution_mode) {
      this.logger.warn(
        `Vault ${vaultId} is not in manual mode. Consider enabling manual_distribution_mode flag first.`
      );
    }

    // Combine existing on-chain multipliers with new ones
    const existingMultipliers = vault.acquire_multiplier || [];
    const existingAdaDistribution = vault.ada_distribution || [];

    const newMultipliers = [...existingMultipliers, ...additionalMultipliers];
    const newAdaDistribution = [...existingAdaDistribution, ...additionalAdaDistribution];

    this.logger.log(
      `Manual vault update for ${vaultId}: ` +
        `Adding ${additionalMultipliers.length} multipliers. ` +
        `Total will be ${newMultipliers.length}. ` +
        `${updateDescription ? `Reason: ${updateDescription}` : ''}`
    );

    try {
      // Submit vault update transaction
      const response = await this.vaultManagingService.updateVaultMetadataTx({
        vault,
        acquireMultiplier: newMultipliers,
        adaDistribution: newAdaDistribution,
        adaPairMultiplier: vault.ada_pair_multiplier || 0,
        vaultStatus: SmartContractVaultStatus.SUCCESSFUL,
      });

      if (!response.txHash) {
        throw new Error('No transaction hash returned from vault update');
      }

      // Update vault in database
      await this.vaultRepository.update(vaultId, {
        acquire_multiplier: newMultipliers,
        ada_distribution: newAdaDistribution,
      });

      // Remove added multipliers from pending (if they were there)
      if (vault.pending_multipliers && vault.pending_multipliers.length > 0) {
        const addedKeys = new Set(additionalMultipliers.map(([p, a]) => `${p}:${a || ''}`));
        const remainingPending = vault.pending_multipliers.filter(([p, a]) => !addedKeys.has(`${p}:${a || ''}`));

        await this.vaultRepository.update(vaultId, {
          pending_multipliers: remainingPending,
        });

        this.logger.log(
          `Updated pending_multipliers: ${vault.pending_multipliers.length} → ${remainingPending.length}`
        );
      }

      return {
        success: true,
        txHash: response.txHash,
        message: `Successfully added ${additionalMultipliers.length} multipliers to vault. Transaction: ${response.txHash}`,
        newMultiplierCount: newMultipliers.length,
        newOnChainMultipliers: newMultipliers,
      };
    } catch (error) {
      this.logger.error(`Failed to manually update vault ${vaultId}:`, error);
      throw error;
    }
  }
}
