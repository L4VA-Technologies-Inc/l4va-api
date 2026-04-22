import { EpochStatus } from '../../../types/rewards.types';

/**
 * Data Transfer Objects for Rewards API (l4va-api)
 * These DTOs represent UI-ready responses for the frontend.
 * They abstract away internal rewards service details.
 */

// ============================================================================
// Summary DTO - Overview of user's rewards
// ============================================================================

export interface RewardsSummaryDto {
  totalEarned: string;
  totalClaimable: string;
  totalVested: string;
  totalClaimed: string;
  currentEpoch?: {
    epochId: string;
    epochNumber: number;
    estimatedReward?: string;
    immediateAmount?: string;
    vestedAmount?: string;
    endsAt: string;
  };
}

// ============================================================================
// Epoch DTOs
// ============================================================================

export interface EpochDto {
  id: string;
  epochNumber: number;
  startDate: string;
  endDate: string;
  status: EpochStatus;
  totalEmission?: string;
  userReward?: {
    total: string;
    immediate: string;
    vested: string;
    score: number;
    isCapped: boolean;
  };
}

export interface EpochsListDto {
  epochs: EpochDto[];
  total: number;
}

export interface CurrentEpochDto {
  epoch: EpochDto | null;
  eventSummary?: {
    totalEvents: number;
    eventBreakdown: Record<string, number>;
  };
}

// ============================================================================
// Score & History DTOs
// ============================================================================

export interface WalletScoreDto {
  walletAddress: string;
  currentEpochScore: number;
  currentEpochId: string;
  currentEpochNumber: number;
  breakdown?: {
    creatorScore: number;
    participantScore: number;
    lpScore: number;
    governanceScore: number;
  };
  estimatedReward?: string;
}

export interface RewardHistoryItemDto {
  epochId: string;
  epochNumber: number;
  epochStartDate: string;
  epochEndDate: string;
  score: number;
  totalReward: string;
  immediateReward: string;
  vestedReward: string;
  isCapped: boolean;
  claimedAt?: string;
  claimTransactionId?: string;
}

export interface WalletHistoryDto {
  walletAddress: string;
  history: RewardHistoryItemDto[];
}

// ============================================================================
// Vault Rewards DTOs
// ============================================================================

export interface VaultScoreEntryDto {
  walletAddress: string;
  score: number;
  rank: number;
  role: 'creator' | 'participant';
  estimatedReward?: string;
}

export interface VaultScoresDto {
  vaultId: string;
  vaultName?: string;
  epochId: string;
  epochNumber: number;
  scores: VaultScoreEntryDto[];
  totalParticipants: number;
}

export interface WalletVaultRewardDto {
  vaultId: string;
  vaultName?: string;
  role: 'creator' | 'participant' | 'both';
  score: number;
  creatorScore?: number;
  participantScore?: number;
  estimatedReward?: string;
  breakdown?: {
    creator?: string;
    participant?: string;
  };
}

export interface WalletVaultsDto {
  walletAddress: string;
  epochId: string;
  epochNumber: number;
  vaults: WalletVaultRewardDto[];
  totalReward: string;
}

// ============================================================================
// Claims DTOs
// ============================================================================

export interface ClaimableRewardDto {
  epochId: string;
  epochNumber: number;
  immediateAmount: string;
  vestedAmount: string;
  totalAmount: string;
  status: 'available' | 'pending' | 'claimed';
}

export interface ClaimsSummaryDto {
  walletAddress: string;
  totalClaimable: string;
  immediateClaimable: string;
  vestedClaimable: string;
  totalClaimed: string;
  pendingClaims: number;
  availableRewards: ClaimableRewardDto[];
  lastClaimDate?: string;
}

export interface ClaimHistoryItemDto {
  claimId: string;
  epochId: string;
  epochNumber: number;
  amount: string;
  type: 'immediate' | 'vested';
  claimedAt: string;
  transactionId: string;
  transactionStatus: 'pending' | 'confirmed' | 'failed';
}

export interface ClaimTransactionDto {
  transactionId: string;
  totalAmount: string;
  claimsCount: number;
  status: 'pending' | 'confirmed' | 'failed';
  createdAt: string;
  confirmedAt?: string;
  txHash?: string;
}

// ============================================================================
// Vesting DTOs
// ============================================================================

export interface VestingPositionDto {
  vestingId: string;
  epochId: string;
  epochNumber: number;
  totalAmount: string;
  releasedAmount: string;
  remainingAmount: string;
  startDate: string;
  endDate: string;
  vestingDuration: number; // days
  status: 'active' | 'completed' | 'cancelled';
  nextRelease?: {
    amount: string;
    date: string;
  };
}

export interface VestingSummaryDto {
  walletAddress: string;
  totalVested: string;
  totalReleased: string;
  totalRemaining: string;
  activePositions: VestingPositionDto[];
  completedPositions: VestingPositionDto[];
}

// ============================================================================
// Configuration DTOs
// ============================================================================

export interface RewardsWeightsDto {
  activityWeights: Record<string, number>;
  creatorShare: number; // percentage
  participantShare: number; // percentage
  immediateRelease: number; // percentage
  vestingDuration: number; // days
  walletCap: string;
}
