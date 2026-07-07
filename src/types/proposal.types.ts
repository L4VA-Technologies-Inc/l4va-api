export enum ProposalStatus {
  /** Proposal is created but governance fee payment is pending */
  UNPAID = 'unpaid',
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
  EXPANSION = 'expansion',
  ACQUIRE_EXPANSION = 'acquire_expansion',
  ASSET_WHITELIST_UPDATE = 'asset_whitelist_update',
  // New staking operations with platform support
  STAKE_ASSETS = 'stake_assets',
  UNSTAKE_ASSETS = 'unstake_assets',
  HARVEST_REWARDS = 'harvest_rewards',
  // Legacy types - kept for backwards compatibility
  RELICS_STAKING = 'relics_staking',
  RELICS_UNSTAKING = 'relics_unstaking',
}

export enum MarketplaceAction {
  SELL = 'sell', // Renamed from LIST to align with ExecType.SELL
  UPDATE_LISTING = 'update_listing',
  UNLIST = 'unlist',
  BUY = 'buy',
  OFFER = 'offer',
  CANCEL_OFFER = 'cancel_offer',
}
