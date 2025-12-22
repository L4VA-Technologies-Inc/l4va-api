export enum ProposalStatus {
  UPCOMING = 'upcoming',
  ACTIVE = 'active',
  PASSED = 'passed',
  REJECTED = 'rejected',
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
