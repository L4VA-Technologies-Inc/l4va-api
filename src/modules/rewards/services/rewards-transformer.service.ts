import { Injectable } from '@nestjs/common';

/**
 * Transforms raw rewards data from l4va-rewards service into UI-ready DTOs.
 * Adds computed properties, normalizes dates, and enriches data for frontend consumption.
 */
@Injectable()
export class RewardsTransformerService {
  // ============================================================================
  // Epoch Transformers
  // ============================================================================

  transformEpoch(epoch: any) {
    if (!epoch) return null;

    return {
      ...epoch,
      startDate: epoch.start_date || epoch.startDate,
      endDate: epoch.end_date || epoch.endDate,
      // Computed properties
      isActive: epoch.status === 'active',
      isProcessing: epoch.status === 'processing',
      isFinalized: epoch.status === 'finalized',
    };
  }

  transformEpochs(data: any) {
    if (!data) return { epochs: [], total: 0 };

    return {
      ...data,
      epochs: Array.isArray(data.epochs) ? data.epochs.map(e => this.transformEpoch(e)) : [],
    };
  }

  transformCurrentEpoch(data: any) {
    if (!data) return { epoch: null };

    return {
      ...data,
      epoch: data.epoch ? this.transformEpoch(data.epoch) : null,
    };
  }

  // ============================================================================
  // Rewards History Transformers
  // ============================================================================

  transformRewardHistoryItem(item: any) {
    if (!item) return null;

    const totalReward = item.total_reward || item.totalReward || 0;
    const immediateReward = item.immediate_reward || item.immediateReward || 0;
    const vestedReward = item.vested_reward || item.vestedReward || 0;

    return {
      ...item,
      // Normalize field names
      totalReward,
      immediateReward,
      vestedReward,
      epochId: item.epoch_id || item.epochId,
      epochNumber: item.epoch_number || item.epochNumber,
      epochStartDate: item.epoch?.start_date || item.epoch?.startDate || item.epochStartDate,
      epochEndDate: item.epoch?.end_date || item.epoch?.endDate || item.epochEndDate,
      claimedAt: item.claimed_at || item.claimedAt,
      claimTransactionId: item.claim_transaction_id || item.claimTransactionId,
      // Computed properties
      hasVestedReward: vestedReward > 0,
      hasImmediateReward: immediateReward > 0,
      rewardSplit: {
        immediate: immediateReward,
        vested: vestedReward,
        immediatePercentage: totalReward > 0 ? (immediateReward / totalReward) * 100 : 0,
        vestedPercentage: totalReward > 0 ? (vestedReward / totalReward) * 100 : 0,
      },
      epoch: item.epoch ? this.transformEpoch(item.epoch) : null,
    };
  }

  transformWalletHistory(data: any) {
    if (!data) return { walletAddress: '', history: [] };

    const history = Array.isArray(data.history || data)
      ? (data.history || data).map(item => this.transformRewardHistoryItem(item))
      : [];

    return {
      walletAddress: data.walletAddress || data.wallet_address || '',
      history,
    };
  }

  // ============================================================================
  // Claims Transformers
  // ============================================================================

  transformClaimHistoryItem(claim: any) {
    if (!claim) return null;

    return {
      ...claim,
      claimId: claim.claim_id || claim.claimId,
      epochId: claim.epoch_id || claim.epochId,
      epochNumber: claim.epoch_number || claim.epochNumber,
      claimedAt: claim.claimed_at || claim.claimedAt,
      transactionId: claim.transaction_id || claim.transactionId,
      transactionStatus: claim.transaction_status || claim.transactionStatus,
      // Computed properties
      isPending: claim.transactionStatus === 'pending' || claim.transaction_status === 'pending',
      isConfirmed: claim.transactionStatus === 'confirmed' || claim.transaction_status === 'confirmed',
      isFailed: claim.transactionStatus === 'failed' || claim.transaction_status === 'failed',
    };
  }

  transformClaimHistory(data: any) {
    if (!data) return [];

    return Array.isArray(data) ? data.map(claim => this.transformClaimHistoryItem(claim)) : [];
  }

  transformClaimTransaction(tx: any) {
    if (!tx) return null;

    return {
      ...tx,
      transactionId: tx.transaction_id || tx.transactionId,
      totalAmount: tx.total_amount || tx.totalAmount,
      claimsCount: tx.claims_count || tx.claimsCount,
      createdAt: tx.created_at || tx.createdAt,
      confirmedAt: tx.confirmed_at || tx.confirmedAt,
      failedAt: tx.failed_at || tx.failedAt,
      txHash: tx.tx_hash || tx.txHash,
      // Computed properties
      isPending: tx.status === 'pending',
      isConfirmed: tx.status === 'confirmed',
      isFailed: tx.status === 'failed',
    };
  }

  transformClaimTransactions(data: any) {
    if (!data) return [];

    return Array.isArray(data) ? data.map(tx => this.transformClaimTransaction(tx)) : [];
  }

  transformClaimsSummary(data: any) {
    if (!data) return null;

    const availableRewards = Array.isArray(data.availableRewards || data.available_rewards)
      ? (data.availableRewards || data.available_rewards).map((reward: any) => ({
          ...reward,
          epochId: reward.epoch_id || reward.epochId,
          epochNumber: reward.epoch_number || reward.epochNumber,
          immediateAmount: reward.immediate_amount || reward.immediateAmount,
          vestedAmount: reward.vested_amount || reward.vestedAmount,
          totalAmount: reward.total_amount || reward.totalAmount,
        }))
      : [];

    return {
      ...data,
      walletAddress: data.walletAddress || data.wallet_address,
      totalClaimable: data.totalClaimable || data.total_claimable,
      immediateClaimable: data.immediateClaimable || data.immediate_claimable,
      vestedClaimable: data.vestedClaimable || data.vested_claimable,
      totalClaimed: data.totalClaimed || data.total_claimed,
      pendingClaims: data.pendingClaims || data.pending_claims,
      lastClaimDate: data.lastClaimDate || data.last_claim_date,
      availableRewards,
    };
  }

  // ============================================================================
  // Vesting Transformers
  // ============================================================================

  transformVestingPosition(position: any) {
    if (!position) return null;

    const startDate = new Date(position.vesting_start || position.start_date || position.startDate);
    const endDate = new Date(position.vesting_end || position.end_date || position.endDate);
    const unlockDate =
      position.unlock_date || position.unlockDate ? new Date(position.unlock_date || position.unlockDate) : null;
    const now = new Date();

    const totalDuration = endDate.getTime() - startDate.getTime();
    const elapsed = now.getTime() - startDate.getTime();
    const progressPercentage = Math.min(Math.max((elapsed / totalDuration) * 100, 0), 100);

    const isPast = (date: Date) => date.getTime() < now.getTime();
    const isFuture = (date: Date) => date.getTime() > now.getTime();

    return {
      ...position,
      vestingId: position.vesting_id || position.vestingId,
      epochId: position.epoch_id || position.epochId,
      epochNumber: position.epoch_number || position.epochNumber,
      totalAmount: position.total_amount || position.totalAmount,
      vestedAmount: position.vested_amount || position.vestedAmount,
      unlockedAmount: position.unlocked_amount || position.unlockedAmount,
      claimedAmount: position.claimed_amount || position.claimedAmount,
      releasedAmount: position.released_amount || position.releasedAmount,
      remainingAmount: position.remaining_amount || position.remainingAmount,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      unlockDate: unlockDate?.toISOString(),
      vestingDuration: position.vesting_duration || position.vestingDuration,
      // Computed properties
      isActive: position.status === 'active',
      isCompleted: position.status === 'completed',
      isCancelled: position.status === 'cancelled',
      hasStarted: isPast(startDate),
      hasEnded: isPast(endDate),
      isUpcoming: isFuture(startDate),
      progressPercentage,
      daysUntilUnlock: unlockDate
        ? Math.max(0, Math.ceil((unlockDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
        : null,
      nextRelease: position.next_release
        ? {
            amount: position.next_release.amount,
            date: position.next_release.date,
          }
        : undefined,
    };
  }

  transformVestingPositions(data: any) {
    if (!data) return [];

    return Array.isArray(data) ? data.map(pos => this.transformVestingPosition(pos)) : [];
  }

  transformVestingSummary(data: any) {
    if (!data) return null;

    const activePositions = this.transformVestingPositions(data.activePositions || data.active_positions || []);
    const completedPositions = this.transformVestingPositions(
      data.completedPositions || data.completed_positions || []
    );

    const totalVested = data.totalVested || data.total_vested || 0;
    const totalReleased = data.totalReleased || data.total_released || 0;
    const totalRemaining = data.totalRemaining || data.total_remaining || 0;
    const totalLocked = data.totalLocked || data.total_locked || totalRemaining;
    const totalUnlocked = data.totalUnlocked || data.total_unlocked || totalReleased;

    return {
      walletAddress: data.walletAddress || data.wallet_address,
      totalVested,
      totalReleased,
      totalRemaining,
      totalLocked,
      totalUnlocked,
      activePositions,
      completedPositions,
      // Computed properties
      hasVestedRewards: totalVested > 0,
      hasLockedRewards: totalLocked > 0,
      hasUnlockedRewards: totalUnlocked > 0,
      lockedPercentage: totalVested > 0 ? (totalLocked / totalVested) * 100 : 0,
      unlockedPercentage: totalVested > 0 ? (totalUnlocked / totalVested) * 100 : 0,
      nextUnlock:
        data.nextUnlock || data.next_unlock
          ? {
              amount: (data.nextUnlock || data.next_unlock).amount,
              date: (data.nextUnlock || data.next_unlock).date,
              daysUntil: Math.max(
                0,
                Math.ceil(
                  (new Date((data.nextUnlock || data.next_unlock).date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                )
              ),
            }
          : null,
    };
  }

  // ============================================================================
  // Vault Rewards Transformers
  // ============================================================================

  transformWalletVaultReward(data: any) {
    if (!data) return null;

    return {
      ...data,
      vaultId: data.vault_id || data.vaultId,
      vaultName: data.vault_name || data.vaultName,
      walletAddress: data.wallet_address || data.walletAddress,
      creatorScore: data.creator_score || data.creatorScore,
      participantScore: data.participant_score || data.participantScore,
      estimatedReward: data.estimated_reward || data.estimatedReward,
      // Computed properties
      isCreator: data.role === 'creator' || data.role === 'both',
      isParticipant: data.role === 'participant' || data.role === 'both',
      hasBothRoles: data.role === 'both',
    };
  }

  transformWalletVaults(data: any) {
    // Handle empty/null data
    if (!data) {
      return {
        walletAddress: '',
        vaults: [],
        epochId: '',
        epochNumber: 0,
        totalRewardBeforeCap: 0,
        totalFinalReward: 0,
        wasCapped: false,
        capDifference: 0,
      };
    }

    const totalRewardBeforeCap = data.total_reward_before_cap || data.totalRewardBeforeCap || 0;
    const totalFinalReward = data.total_final_reward || data.totalFinalReward || 0;
    const wasCapped = data.was_capped || data.wasCapped || false;
    const capDifference = data.cap_difference || data.capDifference || 0;

    return {
      walletAddress: data.wallet_address || data.walletAddress || '',
      epochId: data.epoch_id || data.epochId || '',
      epochNumber: data.epoch_number || data.epochNumber || 0,
      // Vault rewards (uncapped)
      totalRewardBeforeCap,
      // Final rewards (after 5% cap applied)
      totalFinalReward,
      wasCapped,
      capDifference,
      // Backwards compatibility
      totalReward: totalFinalReward || totalRewardBeforeCap,
      vaults: Array.isArray(data.vaults)
        ? data.vaults.map((vault: any) => ({
            ...vault,
            vaultId: vault.vault_id || vault.vaultId,
            vaultName: vault.vault_name || vault.vaultName,
            totalReward: vault.total_reward || vault.totalReward || 0,
            epochCount: vault.epoch_count || vault.epochCount || 0,
            // Computed properties
            isCreator: vault.role === 'creator' || vault.role === 'both',
            isParticipant: vault.role === 'participant' || vault.role === 'both',
            hasBothRoles: vault.role === 'both',
          }))
        : [],
    };
  }

  transformVaultScores(data: any) {
    if (!data) return null;

    return {
      ...data,
      vaultId: data.vault_id || data.vaultId,
      vaultName: data.vault_name || data.vaultName,
      epochId: data.epoch_id || data.epochId,
      epochNumber: data.epoch_number || data.epochNumber,
      totalParticipants: data.total_participants || data.totalParticipants,
      scores: Array.isArray(data.scores)
        ? data.scores.map((score: any) => ({
            ...score,
            walletAddress: score.wallet_address || score.walletAddress,
            estimatedReward: score.estimated_reward || score.estimatedReward,
          }))
        : [],
    };
  }

  // ============================================================================
  // Score Transformers
  // ============================================================================

  transformWalletScore(data: any) {
    if (!data) return null;

    return {
      ...data,
      walletAddress: data.walletAddress || data.wallet_address,
      currentEpochScore: data.currentEpochScore || data.current_epoch_score || data.score,
      currentEpochId: data.currentEpochId || data.current_epoch_id || data.epochId,
      currentEpochNumber: data.currentEpochNumber || data.current_epoch_number || data.epoch_number,
      estimatedReward: data.estimatedReward || data.estimated_reward,
      estimatedScore: data.estimatedScore || data.estimated_score,
      eventCount: data.eventCount || data.event_count,
      // Pass through activity breakdown (keyed by activity type)
      breakdown: data.breakdown || undefined,
    };
  }
}
