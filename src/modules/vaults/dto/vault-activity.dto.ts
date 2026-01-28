import { Transaction } from '@/database/transaction.entity';
import { ProposalStatus } from '@/types/proposal.types';

export enum ActivityType {
  TRANSACTION = 'transaction',
  PROPOSAL_CREATED = 'proposal_created',
  PROPOSAL_STARTED = 'proposal_started',
  PROPOSAL_ENDED = 'proposal_ended',
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

export type VaultActivityItem = TransactionActivityEvent | ProposalActivityEvent;
