import { Transaction } from '@/database/transaction.entity';
import { IndexLegSide, IndexLegStatus, IndexRebalanceStatus, IndexRebalanceTrigger } from '@/types/index-vault.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VaultStatus } from '@/types/vault.types';

export enum ActivityType {
  TRANSACTION = 'transaction',
  PROPOSAL = 'proposal',
  PHASE_TRANSITION = 'phase_transition',
  INDEX_REBALANCE = 'index_rebalance',
}

export enum ProposalLifecycleStage {
  CREATED = 'created',
  STARTED = 'started',
  ENDED = 'ended',
}

export interface ProposalLifecycleEvent {
  stage: ProposalLifecycleStage;
  at: Date;
}

/**
 * One proposal with its whole history: lifecycle stages reached so far plus the
 * on-chain actions it executed. `created_at` is the latest of those, so the
 * proposal sorts by its most recent activity.
 */
export interface ProposalActivityEvent {
  id: string;
  activityType: ActivityType.PROPOSAL;
  proposalId: string;
  proposalType: ProposalType;
  title: string;
  description: string;
  status: ProposalStatus;
  /** Latest lifecycle stage reached. */
  stage: ProposalLifecycleStage;
  lifecycle: ProposalLifecycleEvent[];
  /** Swaps / rebalance runs the proposal executed, oldest first. */
  actions: (TransactionActivityEvent | IndexRebalanceActivityEvent)[];
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
  /** Set on the `locked` transition once the lock outcome is known. */
  summary?: VaultLockSummary | null;
}

/**
 * What the lock settled. Amounts are integer strings in base units: VT in
 * `vtDecimals`, native (lovelace / wei) in `nativeDecimals`.
 */
export interface VaultLockSummary {
  nativeSymbol: 'ADA' | 'ETH';
  nativeDecimals: number;
  vtTicker: string | null;
  vtDecimals: number;
  vtSupply: string;
  /** Configured split, in percent. */
  acquirersPercent: number;
  lpPercent: number;
  /** Value of the contributed assets at lock. */
  assetsValue: string;
  /** Native paid in by acquirers. */
  totalRaised: string;
  fdv: string | null;
  contributorsVt: string;
  acquirersVt: string;
  lpVt: string;
  /** Native paid out to contributors / paired into the LP. */
  contributorsNative: string;
  lpNative: string;
  contributorsCount: number;
  acquirersCount: number;
  txHash: string | null;
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
