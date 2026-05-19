/**
 * Data Transfer Objects for Rewards API (l4va-api)
 * Interfaces mirror the responses returned by l4va-rewards service.
 * No runtime validation is needed here — l4va-api is a thin BFF proxy.
 */

// ============================================================================
// Epoch DTOs
// ============================================================================

export interface EpochDto {
  id: string;
  epochNumber: number;
  startDate: string;
  endDate: string;
  emissionTotal: number;
  walletCapAmount: number;
  status: string;
  createdAt: string;
  finalizedAt: string | null;
  isActive: boolean;
  isProcessing: boolean;
  isFinalized: boolean;
}

export interface EpochsResponseDto {
  epochs: EpochDto[];
  total: number;
}

export interface CurrentEpochResponseDto {
  epoch: EpochDto | null;
  eventSummary?: Record<string, any>;
  message?: string;
  claimsEnabled: boolean;
}

// ============================================================================
// Score & History DTOs
// ============================================================================

export interface WalletScoreDto {
  walletAddress: string;
  epochId: string;
  epochNumber: number;
  activityScore: number;
  alignmentMultiplier: number;
  creatorRewards: number;
  participantRewards: number;
  totalRewardBeforeCap: number;
  finalReward: number;
  wasCapped: boolean;
  immediateReward: number;
  vestedReward: number;
  metadata: Record<string, any>;
}

interface AlignmentBonusDetailDto {
  bonus: number;
  bonusPercent: number;
  achieved: boolean;
}

export interface AlignmentDetailsDto {
  multiplier: number;
  multiplierPercent: number;
  bonuses: {
    l4va: AlignmentBonusDetailDto & { stakedAmount: number; requiredAmount: number };
    vlrm: AlignmentBonusDetailDto & { stakedAmount: number; requiredAmount: number };
    oracle: AlignmentBonusDetailDto & { balance: number; minimumRequired: number };
    alignment: AlignmentBonusDetailDto & { description: string };
  };
  maxMultiplier: number;
  maxMultiplierPercent: number;
}

export interface RewardSplitDto {
  immediate: number;
  vested: number;
  immediatePercentage: number;
  vestedPercentage: number;
}

export interface WalletHistoryItemDto {
  id: string;
  epochId: string;
  walletAddress: string;
  creatorRewardTotal: number;
  participantRewardTotal: number;
  totalRewardBeforeCap: number;
  finalReward: number;
  immediateReward: number;
  vestedReward: number;
  wasCapped: boolean;
  metadata: Record<string, any>;
  createdAt: string;
  totalReward: number;
  hasVestedReward: boolean;
  hasImmediateReward: boolean;
  rewardSplit: RewardSplitDto;
}

export interface WalletHistoryResponseDto {
  walletAddress: string;
  history: WalletHistoryItemDto[];
  totalEarned: number;
  epochCount: number;
}

// ============================================================================
// Vault DTOs
// ============================================================================

export interface VaultParticipantDto {
  walletAddress: string;
  role: string;
  activityScore: number;
  rewardAmount: number;
}

export interface VaultScoreDto {
  vaultId: string;
  epochId: string;
  epochNumber: number;
  totalScore: number;
  totalReward: number;
  creatorReward: number;
  participantReward: number;
  participantCount: number;
  participants: VaultParticipantDto[];
}

export interface WalletVaultRewardDto {
  walletAddress: string;
  vaultId: string;
  epochId: string;
  epochNumber: number;
  role: string;
  activityScore: number;
  rewardAmount: number;
  isCreator: boolean;
  isParticipant: boolean;
}

export interface VaultScoreWithWalletsDto {
  vault: VaultScoreDto;
  walletScores: WalletVaultRewardDto[];
}

export interface WalletVaultDetailsDto {
  walletAddress: string;
  vaultId: string;
  epochId: string;
  epochNumber: number;
  role: string;
  totalReward: number;
  creatorReward: number;
  participantReward: number;
  immediateReward: number;
  vestedReward: number;
}

export interface VaultBreakdownDto {
  vaultId: string;
  vaultName: string;
  totalReward: number;
  epochCount: number;
  role: string;
}

export interface WalletVaultsResponseDto {
  walletAddress: string;
  epochId: string;
  epochNumber: number;
  totalReward: number;
  totalRewardBeforeCap: number;
  totalFinalReward: number;
  wasCapped: boolean;
  capDifference: number;
  vaults: VaultBreakdownDto[];
}

export interface VaultTimelineItemDto {
  epochId: string;
  epochEnd: string;
  epochNumber: number;
  vaultId: string;
  vaultName: string;
  rewardAmount: number;
}

export interface WalletVaultTimelineDto {
  walletAddress: string;
  timeline: VaultTimelineItemDto[];
}

export interface ActivityTimelineItemDto {
  epochId: string;
  epochEnd: string;
  epochNumber: number;
  activityType: string;
  rewardAmount: number;
}

export interface WalletActivityTimelineDto {
  walletAddress: string;
  timeline: ActivityTimelineItemDto[];
}

export interface CurrentEpochEstimateDto {
  estimatedReward: number;
  confidence: 'low' | 'stabilizing' | 'near-final';
  confidenceLabel: string;
  epochProgress: number;
  epochNumber: number;
  hasActivity: boolean;
}

// ============================================================================
// Claims DTOs
// ============================================================================

export interface AvailableRewardDto {
  epochId: string;
  epochNumber: number;
  immediateAmount: number;
  vestedAmount: number;
  totalAmount: number;
  claimableNow: number;
  hasVestedReward: boolean;
  hasImmediateReward: boolean;
}

export interface ClaimsSummaryDto {
  walletAddress: string;
  totalClaimable: number;
  immediateClaimable: number;
  vestedClaimable: number;
  totalClaimed: number;
  pendingClaims: number;
  lastClaimDate: string | null;
  availableRewards: AvailableRewardDto[];
}

export interface ClaimHistoryItemDto {
  id: string;
  epochId: string;
  walletAddress: string;
  rewardAmount: number;
  immediateAmount: number;
  vestedAmount: number;
  claimedImmediateAmount: number;
  claimedVestedAmount: number;
  remainingImmediateAmount: number;
  remainingVestedAmount: number;
  status: string;
  claimTransactionId: string | null;
  claimedAt: string | null;
}

export interface ClaimTransactionDto {
  transactionId: string;
  totalAmount: number;
  claimsCount: number;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  failedAt: string | null;
  txHash: string | null;
  isPending: boolean;
  isConfirmed: boolean;
  isFailed: boolean;
}

export interface PrepareClaimResponseDto {
  reservationId: string;
  txCbor: string;
  claimableImmediateAmount: number;
  claimableVestedAmount: number;
  totalClaimableAmount: number;
}

export interface SubmitClaimResponseDto {
  success: boolean;
  txHash: string;
  claimedAmount: number;
  claimedImmediateAmount: number;
  claimedVestedAmount: number;
}

export interface CancelClaimResponseDto {
  cancelled: boolean;
  message?: string;
}

// ============================================================================
// Vesting DTOs
// ============================================================================

export interface NextReleaseDto {
  amount: number;
  date: string;
}

export interface VestingPositionDto {
  vestingId: string;
  epochId: string;
  epochNumber: number;
  walletAddress: string;
  totalAmount: number;
  vestedAmount: number;
  unlockedAmount: number;
  claimedAmount: number;
  releasedAmount: number;
  remainingAmount: number;
  startDate: string;
  endDate: string;
  unlockDate: string | null;
  vestingDuration: number;
  status: string;
  isActive: boolean;
  isCompleted: boolean;
  isCancelled: boolean;
  hasStarted: boolean;
  hasEnded: boolean;
  isUpcoming: boolean;
  progressPercentage: number;
  daysUntilUnlock: number | null;
  nextRelease: NextReleaseDto | null;
}

export interface VestingPositionsResponseDto {
  walletAddress: string;
  positions: VestingPositionDto[];
  totalPositions: number;
  activePositions: number;
}

export interface VestingSummaryDto {
  walletAddress: string;
  totalVested: number;
  totalUnlocked: number;
  totalClaimed: number;
  totalRemaining: number;
  availableToClaim: number;
  activePositionsCount: number;
  overallProgress: number;
  nextUnlock?: { amount: number; date: string };
  positions: VestingPositionDto[];
}
