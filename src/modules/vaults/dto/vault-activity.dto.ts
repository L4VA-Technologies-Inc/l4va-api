import { Transaction } from '@/database/transaction.entity';
import { IndexLegSide, IndexLegStatus, IndexRebalanceStatus, IndexRebalanceTrigger } from '@/types/index-vault.types';
import { ProposalStatus } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';

export enum ActivityType {
  TRANSACTION = 'transaction',
  PROPOSAL_CREATED = 'proposal_created',
  PROPOSAL_STARTED = 'proposal_started',
  PROPOSAL_ENDED = 'proposal_ended',
  PHASE_TRANSITION = 'phase_transition',
  INDEX_REBALANCE = 'index_rebalance',
}

export interface ProposalActivityEvent {
  id: string;
  activityType: ActivityType.PROPOSAL_CREATED | ActivityType.PROPOSAL_STARTED | ActivityType.PROPOSAL_ENDED;
  proposalId: string;
  title: string;
  description: string;
  status: ProposalStatus;
  creatorId: string;
  created_at: Date;
  executionError?: string;
}

export interface TransactionActivityEvent extends Transaction {
  activityType: ActivityType.TRANSACTION;
}

export interface PhaseTransitionEvent {
  id: string;
  activityType: ActivityType.PHASE_TRANSITION;
  vaultId: string;
  phase: VaultStatus;
  created_at: Date;
}

export interface IndexRebalanceActivityAsset {
  /** address(0) = native. */
  address: string;
  symbol: string;
  decimals: number;
  image?: string | null;
}

export interface IndexRebalanceActivityLeg {
  index: number;
  side: IndexLegSide;
  status: IndexLegStatus;
  assetIn: IndexRebalanceActivityAsset;
  assetOut: IndexRebalanceActivityAsset;
  /** Raw base units. */
  amountIn: string;
  /** Raw base units; settled output when confirmed, quote otherwise. */
  amountOut?: string | null;
  fee?: string | null;
  txHash?: string | null;
  error?: string | null;
}

/** One basket rebalance (initial buy or governance re-weight) with its swap legs. */
export interface IndexRebalanceActivityEvent {
  id: string;
  activityType: ActivityType.INDEX_REBALANCE;
  vaultId: string;
  trigger: IndexRebalanceTrigger;
  status: IndexRebalanceStatus;
  proposalId?: string | null;
  navNative?: string | null;
  legs: IndexRebalanceActivityLeg[];
  lastError?: string | null;
  completedAt?: Date | null;
  created_at: Date;
}

export type VaultActivityItem =
  | TransactionActivityEvent
  | ProposalActivityEvent
  | PhaseTransitionEvent
  | IndexRebalanceActivityEvent;
