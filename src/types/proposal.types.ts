export enum ProposalStatus {
  /** Proposal is created but not yet active */
  UPCOMING = 'upcoming',
  /** Proposal is currently active and open for voting */
  ACTIVE = 'active',
  /** Proposal has met the required votes and is approved for execution */
  PASSED = 'passed',
  /** Proposal has not met the required votes and is rejected */
  REJECTED = 'rejected',
  /** Proposal has been executed (all actions completed) */
  EXECUTED = 'executed',
}

/**
 * Types of proposals that can be created
 */
export enum ProposalType {
  STAKING = 'staking',
  DISTRIBUTION = 'distribution',
  TERMINATION = 'termination',
  BURNING = 'burning',
  BUY_SELL = 'buy_sell', // Deprecated
  MARKETPLACE_ACTION = 'marketplace_action',
}

export enum MarketplaceAction {
  SELL = 'sell', // Renamed from LIST to align with ExecType.SELL
  UPDATE_LISTING = 'update_listing',
  UNLIST = 'unlist',
  BUY = 'buy',
}
