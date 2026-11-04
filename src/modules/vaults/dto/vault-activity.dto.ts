import { Transaction } from '@/database/transaction.entity';
import { IndexLegSide, IndexLegStatus, IndexRebalanceStatus, IndexRebalanceTrigger } from '@/types/index-vault.types';
import { ProposalStatus, ProposalType } from '@/types/proposal.types';
import { VaultFailureReason, VaultStatus } from '@/types/vault.types';

export enum ActivityType {
  TRANSACTION = 'transaction',
  PROPOSAL = 'proposal',
  PHASE_TRANSITION = 'phase_transition',
  INDEX_REBALANCE = 'index_rebalance',
  TERMINATION = 'termination',
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
  endDate: Date | null;
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
  /** Set on the `failed` transition. */
  failure?: VaultFailureInfo | null;
  /** Failed vault only: cycle cancel + refund txs it triggered, oldest first. */
  actions?: TransactionActivityEvent[];
  /** `expansion` / `acquire_expansion` phases: which window, and whether it opened or closed. */
  expansion?: ExpansionPhaseInfo;
}

export type ExpansionOutcome = 'completed' | 'cancelled';

export interface ExpansionPhaseInfo {
  proposalId: string;
  /** 1-based, counted per expansion type. */
  number: number;
  stage: 'started' | 'closed';
  /** Closed only. `cancelled`: the EVM cycle was cancelled and contributions refunded. */
  outcome?: ExpansionOutcome;
  /** Closed only, when recorded: duration_expired | asset_max_reached | max_ada_reached. */
  reason?: string | null;
  /** Cancelled only: why the cycle was cancelled, when known. */
  reasonMessage?: string | null;
  /** Closed (not cancelled) only: who received vault tokens for this window. */
  distribution?: ExpansionDistribution | null;
}

export interface ExpansionRecipient {
  address: string | null;
  /** VT base units. */
  vtAmount: string;
  /** EVM: claimed from the allocation root. Cardano: dispatched to the wallet. */
  received: boolean;
  txHash: string | null;
}

export interface ExpansionDistribution {
  vtTicker: string | null;
  vtDecimals: number;
  /** VT base units across all recipients. */
  totalVt: string;
  recipientsCount: number;
  receivedCount: number;
  /** Largest first, capped; `recipientsCount` is the full count. */
  recipients: ExpansionRecipient[];
}

export interface VaultFailureInfo {
  reason: VaultFailureReason | null;
  message: string | null;
  /** Raw failure details (thresholds, required vs actual amounts, ...). */
  details: Record<string, any> | null;
  /** Any confirmed contribute / acquire tx exists, i.e. there is something to refund. */
  hasDeposits: boolean;
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

export enum TerminationActivityStatus {
  VOTING = 'voting',
  REJECTED = 'rejected',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export type TerminationStepStatus = 'done' | 'current' | 'failed' | 'upcoming';

export interface TerminationStep {
  /** Step id, e.g. `voting_ended`, `rates_committed`, `nfts_burned`. */
  key: string;
  status: TerminationStepStatus;
  at?: Date | null;
  txHash?: string | null;
  note?: string | null;
}

/**
 * One termination proposal with everything it set in motion. Replaces the
 * proposal's own card in the feed; `created_at` is the latest step reached.
 */
export interface TerminationActivityEvent {
  id: string;
  activityType: ActivityType.TERMINATION;
  vaultId: string;
  chain: 'cardano' | 'evm';
  status: TerminationActivityStatus;
  proposal: {
    id: string;
    title: string;
    status: ProposalStatus;
    startDate?: Date | null;
    endDate?: Date | null;
  };
  /** Holder payout progress: Cardano termination claims, EVM operator `redeemFor` pushes. */
  redemption?: {
    deadline?: Date | null;
    claimed: number;
    total?: number | null;
  } | null;
  steps: TerminationStep[];
  error?: string | null;
  created_at: Date;
}

export type VaultActivityItem =
  | TransactionActivityEvent
  | ProposalActivityEvent
  | PhaseTransitionEvent
  | IndexRebalanceActivityEvent
  | TerminationActivityEvent;
