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
  BUY_SELL = 'buy_sell',
}
